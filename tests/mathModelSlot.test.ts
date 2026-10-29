import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireMathModelSlot, configuredMathModelSlots, MODEL_SLOT_DIRECTORY_KEY, MODEL_SLOTS_KEY } from '../src/math/mathModelSlot';

const temporary: string[] = [];
afterEach(() => { for (const item of temporary.splice(0)) fs.rmSync(item, { recursive: true, force: true }); });
function directory(): string {
  const created = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-model-slot-')));
  temporary.push(created);
  return path.join(created, 'slots');
}
function holds(file: string): { child: ReturnType<typeof spawn>; descriptor: number } {
  const descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR, 0o600);
  const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', descriptor] });
  return { child, descriptor };
}

describe('host model admission', () => {
  it('is disabled when unconfigured and fails closed on malformed settings', () => {
    expect(configuredMathModelSlots({})).toBeUndefined();
    expect(configuredMathModelSlots({ [MODEL_SLOTS_KEY]: '  ' })).toBeUndefined();
    expect(configuredMathModelSlots({ [MODEL_SLOTS_KEY]: '0' })).toBeUndefined();
    expect(() => configuredMathModelSlots({ [MODEL_SLOTS_KEY]: 'two', [MODEL_SLOT_DIRECTORY_KEY]: '/tmp/slots' }))
      .toThrow('math_model_slots_invalid');
    expect(() => configuredMathModelSlots({ [MODEL_SLOTS_KEY]: '2' })).toThrow('math_model_slot_directory_invalid');
    expect(() => configuredMathModelSlots({ [MODEL_SLOTS_KEY]: '2', [MODEL_SLOT_DIRECTORY_KEY]: 'relative/slots' }))
      .toThrow('math_model_slot_directory_invalid');
    expect(configuredMathModelSlots({ [MODEL_SLOTS_KEY]: '2', [MODEL_SLOT_DIRECTORY_KEY]: '/tmp/slots' }))
      .toEqual({ capacity: 2, directory: '/tmp/slots' });
  });

  it('waits while another process holds the only slot and takes it on release', async () => {
    const slots = directory(), configuration = { capacity: 1, directory: slots };
    fs.mkdirSync(slots, { recursive: true, mode: 0o700 });
    const holder = holds(path.join(slots, 'slot-0.lock'));
    await new Promise<void>((resolve, reject) => {
      holder.child.once('exit', code => code === 0 ? resolve() : reject(new Error('holder failed')));
      holder.child.once('error', reject);
    });
    const controller = new AbortController(), blocked = acquireMathModelSlot(configuration, { signal: controller.signal,
      wait: async delayMs => { await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, 20))); } });
    let settled = false;
    void blocked.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    fs.closeSync(holder.descriptor);
    const slot = await blocked;
    expect(slot.index).toBe(0);
    await slot.release();
    const again = await acquireMathModelSlot(configuration, { wait: async () => { await new Promise(resolve => setTimeout(resolve, 20)); } });
    expect(again.index).toBe(0);
    await again.release();
  });

  it('rejects a slot file that other writers could reach and honours cancellation', async () => {
    const slots = directory();
    fs.mkdirSync(slots, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(slots, 'slot-0.lock'), '', { mode: 0o644 });
    await expect(acquireMathModelSlot({ capacity: 1, directory: slots })).rejects.toThrow('math_model_slot_integrity');
    fs.chmodSync(path.join(slots, 'slot-0.lock'), 0o600);
    const holder = holds(path.join(slots, 'slot-0.lock'));
    await new Promise<void>((resolve, reject) => {
      holder.child.once('exit', code => code === 0 ? resolve() : reject(new Error('holder failed')));
      holder.child.once('error', reject);
    });
    const controller = new AbortController();
    const waiting = acquireMathModelSlot({ capacity: 1, directory: slots }, { signal: controller.signal,
      wait: async delayMs => { await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, 20))); } });
    setTimeout(() => controller.abort(), 200);
    await expect(waiting).rejects.toThrow();
    fs.closeSync(holder.descriptor);
  });

  it('spreads competitors across slots instead of serializing on the first one', async () => {
    const configuration = { capacity: 3, directory: directory() };
    const first = await acquireMathModelSlot(configuration);
    const second = await acquireMathModelSlot(configuration);
    const third = await acquireMathModelSlot(configuration);
    expect(new Set([first.index, second.index, third.index]).size).toBe(3);
    await Promise.all([first.release(), second.release(), third.release()]);
  });
});
