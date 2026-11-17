/** Native fs/watch peer for disposable stdio fixtures; no provider or polling. */
export const nativeFileWatchFixture = String.raw`
(() => {
  const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
  const watches = new Map();
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const call = JSON.parse(line), params = call.params || {};
    if (call.method === 'fs/watch') {
      if (process.env.FIXTURE_NOOP_WATCH === '1') {
        send({ id: call.id, result: { path: params.path } }); return;
      }
      const root = fs.realpathSync(params.path), changed = new Set();
      const entry = { watcher: undefined, timer: undefined };
      entry.watcher = fs.watch(root, (_event, file) => {
        if (file) changed.add(path.join(root, file.toString()));
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          if (watches.get(params.watchId) !== entry || !changed.size) return;
          send({ method: 'fs/changed', params: { watchId: params.watchId, changedPaths: [...changed] } });
          changed.clear();
        }, 200);
      });
      watches.set(params.watchId, entry);
      send({ id: call.id, result: { path: root } });
    } else if (call.method === 'fs/unwatch') {
      if (process.env.FIXTURE_UNWATCH_FAILURE === '1') {
        send({ id: call.id, error: { code: -32603, message: 'Fixture could not remove watch' } }); return;
      }
      const entry = watches.get(params.watchId);
      if (entry) { watches.delete(params.watchId); clearTimeout(entry.timer); entry.watcher.close(); }
      send({ id: call.id, result: {} });
    }
  });
})();
`;
