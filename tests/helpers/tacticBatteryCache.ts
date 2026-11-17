/** Apply to every independently bundled fixture that can start a solver. */
export function tacticBatteryCacheTestDefines(root: string): Record<string, string> {
  return { __THEOREMOS_TEST_TACTIC_BATTERY_CACHE_ROOT__: JSON.stringify(root) };
}
