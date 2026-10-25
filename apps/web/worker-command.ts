import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleWebWorkerCommand } from './workerBridge';

/** Private docker-exec input; command payloads never become arguments or container metadata. */
export async function runWebWorkerCommand(input: NodeJS.ReadableStream = process.stdin): Promise<void> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 1024 * 1024) throw new Error('web_command_too_large');
      chunks.push(buffer);
    }
    const command = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    const result = await handleWebWorkerCommand(command);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ id: 'command', status: 'rejected',
      reason: error instanceof Error ? error.message : 'web_command_failed' }) + '\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void runWebWorkerCommand();
