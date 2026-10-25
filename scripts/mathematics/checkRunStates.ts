#!/usr/bin/env bun
import fs from 'node:fs';
import { checkSolverRunState } from '../../src/solver/stateInvariants';
import type { SolverRunState } from '../../src/solver/archive';

// Reads stored states only; old schemas are checked loosely instead of being rejected.
const paths = process.argv.slice(2).flatMap(argument => argument === '-' ? fs.readFileSync(0, 'utf8').split('\n') : [argument])
  .map(item => item.trim()).filter(Boolean);
if (!paths.length || paths.includes('--help')) {
  console.log('Usage: checkRunStates.ts STATE_JSON... | -   (reads paths from stdin with -)\nPrints one JSON line per state with invariant violations.');
} else {
  let errors = 0;
  for (const file of paths) {
    let violations;
    try { violations = checkSolverRunState(JSON.parse(fs.readFileSync(file, 'utf8')) as SolverRunState); }
    catch (error) { violations = [{ code: 'state_unreadable', severity: 'error', message: String(error), refs: [] }]; }
    if (violations.some(item => item.severity === 'error')) errors++;
    if (violations.length) console.log(JSON.stringify({ file, violations }));
  }
  if (errors) process.exitCode = 1;
}
