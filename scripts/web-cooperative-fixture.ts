import assert from 'node:assert/strict';
import type { BrowserContext } from 'playwright';
import type { createWebService } from '../apps/web/server';
import { accountLogin, type WebRunInput, type WebSession } from '../apps/web/shared';

/** Install a legacy cooperative test fixture before exercising its current readers and commands. */
export async function seedCooperativeRun(service: ReturnType<typeof createWebService>, context: BrowserContext,
  origin: string, input: WebRunInput) {
  const sessionResponse = await context.request.get(origin + '/api/session');
  assert.equal(sessionResponse.status(), 200);
  const session: WebSession = await sessionResponse.json();
  const provider = session.providers.find(item => item.id === input.providerId);
  assert.ok(provider);
  const account = session.account && accountLogin(session.account);
  const owner = service.auth
    ? service.auth.listAccounts().find(item => accountLogin(item) === account)?.id
    : (await context.cookies(origin)).find(item => item.name === 'theoremos_session')?.value;
  assert.ok(owner);
  return service.jobs.create(service.auth ? 'account:' + owner : owner, { ...input, source: input.source.trim() }, provider);
}
