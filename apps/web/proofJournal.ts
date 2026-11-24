import path from 'node:path';
import { writeMathTextDurable } from '../../src/math/mathRuntimeIo';
import type { WorkerMessage } from './shared';

export const webProofJournalDirectory = '/var/theoremos-proof';
export const webProofJournalFiles = ['transitions.json', 'observation.json', 'artifact.json', 'terminal.json'] as const;

/** Keep the latest public evidence on disk even when no process is reading stdout. */
export function webProofMessageSink(output: NodeJS.WritableStream, apiKey: string,
  journal?: { directory: string; webRunId: string }) {
  const secret = JSON.stringify(apiKey).slice(1, -1);
  const redact = (value: unknown) => {
    const json = JSON.stringify(value);
    return secret ? json.replaceAll(secret, '[REDACTED]') : json;
  };
  const transitions: Extract<WorkerMessage, { type: 'library_restart' }>[] = [];
  let disconnected = false;
  output.on('error', () => { disconnected = true; });
  return (message: WorkerMessage) => {
    if (journal) {
      let file: typeof webProofJournalFiles[number] | undefined;
      switch (message.type) {
        case 'library_restart': transitions.push(message); file = 'transitions.json'; break;
        case 'observation': file = 'observation.json'; break;
        case 'artifact': file = 'artifact.json'; break;
        case 'result':
        case 'error': file = 'terminal.json'; break;
      }
      if (file) {
        try {
          writeMathTextDurable(path.join(journal.directory, file), redact({
            webRunId: journal.webRunId,
            messages: message.type === 'library_restart' ? transitions : [message],
          }) + '\n');
        } catch { /* A failed backup write must not suppress the live result. */ }
      }
    }
    if (!disconnected) output.write(redact(message) + '\n');
  };
}
