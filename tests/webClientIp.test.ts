import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { WebSession } from '../apps/web/shared';

const runner: WebRunner = { async readiness() { return { ready: true, message: 'Test worker ready' }; }, async run() { /* No run is started here. */ } };

describe('rate limits behind a tunnel', () => {
  let root: string | undefined, service: ReturnType<typeof createWebService> | undefined;
  afterEach(async () => {
    await service?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    service = root = undefined;
  });

  async function start(env: Record<string, string>) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-web-client-ip-'));
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const baseUrl = `http://127.0.0.1:${port}`;
    service = createWebService({ ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: baseUrl, THEOREMOS_WEB_AUTH: 'email',
      THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_DATA_ROOT: root, ...env }), staticRoot: root }, runner, { mailer: async () => {} });
    await new Promise<void>(resolve => service!.server.listen(port, '127.0.0.1', resolve));
    const session = await fetch(`${baseUrl}/api/session`);
    const cookie = session.headers.get('set-cookie')!.split(';')[0], csrf = (await session.json() as WebSession).csrfToken;
    // Captchas are limited to 30 per address every 10 minutes.
    return async (visitor: string, times: number) => {
      const statuses: number[] = [];
      for (let index = 0; index < times; index++) statuses.push((await fetch(`${baseUrl}/api/auth/captcha`, { method: 'POST',
        headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', 'CF-Connecting-IP': visitor }, body: '{}' })).status);
      return statuses;
    };
  }

  it('counts each visitor named by the configured proxy header separately', async () => {
    const captchas = await start({ THEOREMOS_WEB_CLIENT_IP_HEADER: 'CF-Connecting-IP' });
    expect((await captchas('203.0.113.7', 31)).at(-1)).toBe(429);
    expect(await captchas('198.51.100.4', 1)).toEqual([200]);
  });

  it('ignores the header unless it is configured, so a direct client cannot pick its own address', async () => {
    const captchas = await start({});
    expect((await captchas('203.0.113.7', 30)).every(status => status === 200)).toBe(true);
    expect(await captchas('198.51.100.4', 1)).toEqual([429]);
  });

  it('rejects a header setting that is not a header name', () => {
    expect(() => readWebConfig({ THEOREMOS_WEB_CLIENT_IP_HEADER: 'x-real-ip: 1.2.3.4' })).toThrow('THEOREMOS_WEB_CLIENT_IP_HEADER');
  });
});
