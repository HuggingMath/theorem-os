type Text = { zh: string; en: string };
export type ChatLibraryReference = {
  catalogDigest: string; file: string; declaration: string; title: Text; summary: Text;
  expression: string; type: string; import: string; source: string;
  conditions: { expression: string; meaning: Text }[]; context: string[];
};

export const libraryReferenceId = (item: ChatLibraryReference) => JSON.stringify([item.catalogDigest, item.file, item.declaration]);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is Text => record(value) && typeof value.zh === 'string' && typeof value.en === 'string';

/** Persist only the mathematical reference fields, alongside the owner's unsent draft. */
export function decodeLibraryReferences(value: unknown): ChatLibraryReference[] {
  if (!Array.isArray(value)) return [];
  const items = new Map<string, ChatLibraryReference>();
  for (const item of value) {
    if (!record(item) || !['catalogDigest', 'file', 'declaration', 'expression', 'type', 'import', 'source'].every(key => typeof item[key] === 'string')
      || !text(item.title) || !text(item.summary) || !Array.isArray(item.context) || !item.context.every(part => typeof part === 'string')
      || !Array.isArray(item.conditions) || !item.conditions.every(part => record(part) && typeof part.expression === 'string' && text(part.meaning))
      || !/^https?:\/\//u.test(String(item.source))) continue;
    const reference: ChatLibraryReference = { catalogDigest: item.catalogDigest as string, file: item.file as string,
      declaration: item.declaration as string, title: { ...item.title }, summary: { ...item.summary }, expression: item.expression as string,
      type: item.type as string, import: item.import as string, source: item.source as string, context: [...item.context] as string[],
      conditions: item.conditions.map(part => ({ expression: part.expression, meaning: { ...part.meaning } })) };
    items.set(libraryReferenceId(reference), reference);
  }
  return [...items.values()];
}

/** The visible question stays separate; the actual message includes the complete pinned reference. */
export function withLibraryReferences(question: string, references: readonly ChatLibraryReference[], language: 'zh' | 'en'): string {
  const tx = (zh: string, en: string) => language === 'zh' ? zh : en;
  return [question, ...references.map(item => {
    const code = [item.import, `#check @${item.declaration}`, ...item.context, item.type].join('\n\n');
    const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/gu)].map(match => match[0].length + 1)));
    return [tx(`引用数学库：${item.declaration}`, `Mathematical library reference: ${item.declaration}`),
      item.summary[language], `${fence}lean\n${code}\n${fence}`, `Source: ${item.source}`, `Catalog SHA-256: ${item.catalogDigest}`].join('\n\n');
  })].join('\n\n');
}
