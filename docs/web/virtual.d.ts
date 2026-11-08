declare module 'virtual:archive' {
  const catalog: import('./types').ArchiveIndex;
  export default catalog;
}

declare module 'virtual:proof-figures' {
  const version: string;
  export default version;
}

declare module 'virtual:solution-route' {
  const version: string;
  export default version;
}
