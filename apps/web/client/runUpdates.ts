/** Live invalidations share the ordinary authenticated run-list read path. */
export class RunUpdates {
  private source?: EventSource;
  connected = false;
  constructor(private changed: (version: string) => void, private connectionChanged: () => void) {}

  start() {
    if (this.source || typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/runs/stream');
    this.source = source;
    source.addEventListener('runs-changed', event => {
      if (this.source !== source) return;
      let payload: unknown;
      try { payload = JSON.parse((event as MessageEvent<string>).data); } catch { return; }
      if (!payload || typeof payload !== 'object' || !('version' in payload)
        || typeof payload.version !== 'string' || !payload.version) return;
      this.setConnected(true);
      this.changed(payload.version);
    });
    source.addEventListener('error', () => {
      if (this.source === source) this.setConnected(false);
    });
  }

  stop() {
    this.source?.close();
    this.source = undefined;
    this.setConnected(false);
  }

  private setConnected(connected: boolean) {
    if (this.connected === connected) return;
    this.connected = connected;
    this.connectionChanged();
  }
}
