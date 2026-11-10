export type ProductBuild = { schema: 'theorem-os.web-build.v1'; builtAt: string; digest: string; commit?: string; modified?: boolean };
export type ProductStatus = { checkedAt: string; release: { commit?: string; frontend?: ProductBuild };
  service: { reachable: true; maintenance: boolean; writable: boolean; runtimeReady: boolean } };
