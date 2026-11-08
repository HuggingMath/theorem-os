import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Use the requested release, or the newest installed elan toolchain for optional local checks. */
export function newestLeanBinary(): string | undefined {
  const selected = process.env.THEOREMOS_TEST_LEAN_VERSION?.trim();
  const toolchains = path.join(os.homedir(), '.elan', 'toolchains');
  const installed = (fs.existsSync(toolchains) ? fs.readdirSync(toolchains) : []).flatMap(name => {
    const match = /---v(\d+)\.(\d+)\.(\d+)(?:-rc(\d+))?$/u.exec(name), lean = path.join(toolchains, name, 'bin', 'lean');
    // A release ranks above its own release candidates.
    return match && (!selected || name.endsWith(`---v${selected}`)) && fs.existsSync(lean)
      ? [{ lean, version: [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])] }]
      : [];
  });
  const executable = installed.sort((left, right) => {
    const index = left.version.findIndex((value, position) => value !== right.version[position]);
    return index < 0 ? 0 : right.version[index]! - left.version[index]!;
  })[0]?.lean;
  if (!executable && (selected || process.env.THEOREMOS_TEST_REQUIRE_LEAN === '1'))
    throw new Error(`Lean${selected ? ` ${selected}` : ''} is required for native solver regressions; install its elan toolchain before running this suite.`);
  return executable;
}
