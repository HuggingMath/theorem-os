import fs from 'node:fs';
import path from 'node:path';
import type { ProductBuild, ProductStatus } from './productStatusTypes';

/** Only public build identities enter support reports; paths, accounts and provider details stay out. */
export function readProductBuild(staticRoot: string): ProductBuild | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(staticRoot, 'build-info.json'), 'utf8')) as Partial<ProductBuild>;
    if (value.schema !== 'theorem-os.web-build.v1' || typeof value.builtAt !== 'string' || !Number.isFinite(Date.parse(value.builtAt)) || !/^[a-f0-9]{64}$/u.test(value.digest ?? '')) return;
    return { schema: value.schema, builtAt: value.builtAt, digest: value.digest!,
      ...(/^[a-f0-9]{7,40}$/u.test(value.commit ?? '') ? { commit: value.commit } : {}), ...(value.modified === true ? { modified: true } : {}) };
  } catch { return; }
}
export function productStatus(input: { build?: ProductBuild; commit?: string; maintenance: boolean; writable: boolean; runtimeReady: boolean }): ProductStatus {
  return { checkedAt: new Date().toISOString(), release: { ...(input.commit ? { commit: input.commit } : {}), ...(input.build ? { frontend: input.build } : {}) },
    service: { reachable: true, maintenance: input.maintenance, writable: input.writable, runtimeReady: input.runtimeReady } };
}
