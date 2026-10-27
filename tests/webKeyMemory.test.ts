import { describe, expect, it } from 'vitest';
import { forgetKey, hasRememberedKey, keyMemoryStorageKey, rememberKey, rememberedKey } from '../apps/web/client/keyMemory';

const memory = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key), values };
};

describe('tab API Key memory', () => {
  it('answers only for the provider and address the key was entered for', () => {
    const storage = memory(), source = () => storage;
    expect(rememberKey(source, { providerId: 'openai', baseUrl: 'https://a.example/v1', apiKey: 'sk-one' })).toBe(true);
    expect(rememberedKey(source, 'openai', 'https://a.example/v1')).toBe('sk-one');
    expect(rememberedKey(source, 'openai', 'https://b.example/v1')).toBeUndefined();
    expect(rememberedKey(source, 'other', 'https://a.example/v1')).toBeUndefined();
    expect(hasRememberedKey(source)).toBe(true);
    forgetKey(source);
    expect(hasRememberedKey(source)).toBe(false);
    expect(storage.values.size).toBe(0);
  });

  it('ignores damaged records and survives blocked storage', () => {
    const storage = memory(), source = () => storage;
    for (const value of ['not json', 'null', '{"providerId":"openai","baseUrl":"x","apiKey":""}', '{"providerId":1,"baseUrl":"x","apiKey":"sk"}']) {
      storage.setItem(keyMemoryStorageKey, value);
      expect(rememberedKey(source, 'openai', 'x')).toBeUndefined();
      expect(hasRememberedKey(source)).toBe(false);
    }
    const blocked = () => { throw new Error('SecurityError'); };
    expect(rememberKey(blocked, { providerId: 'openai', baseUrl: 'x', apiKey: 'sk' })).toBe(false);
    expect(rememberedKey(blocked, 'openai', 'x')).toBeUndefined();
    expect(() => forgetKey(blocked)).not.toThrow();
    const full = { ...memory(), setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(rememberKey(() => full, { providerId: 'openai', baseUrl: 'x', apiKey: 'sk' })).toBe(false);
  });
});
