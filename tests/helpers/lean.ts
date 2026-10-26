import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The newest installed elan toolchain's `lean`, ordered by version rather than name: v4.8.0 is older than v4.35.0-rc3. */
export function newestLeanBinary(): string | undefined {
  const toolchains = path.join(os.homedir(), '.elan', 'toolchains');
  if (!fs.existsSync(toolchains)) return undefined;
  const installed = fs.readdirSync(toolchains).flatMap(name => {
    const match = /---v(\d+)\.(\d+)\.(\d+)(?:-rc(\d+))?$/u.exec(name), lean = path.join(toolchains, name, 'bin', 'lean');
    // A release ranks above its own release candidates.
    return match && fs.existsSync(lean)
      ? [{ lean, version: [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])] }]
      : [];
  });
  return installed.sort((left, right) => {
    const index = left.version.findIndex((value, position) => value !== right.version[position]);
    return index < 0 ? 0 : right.version[index]! - left.version[index]!;
  })[0]?.lean;
}
