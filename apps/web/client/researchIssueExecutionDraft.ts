type IssueExecutionScope = { owner: string; projectId: string; issueId: string };
type LegacyDraft = { text?: unknown; objective?: unknown; dependencies?: unknown };

export function readIssueExecutionNotes(storage: Pick<Storage, 'getItem'>, scope: IssueExecutionScope) {
  const suffix = encodeURIComponent(JSON.stringify([scope.owner, scope.projectId, scope.issueId]));
  const read = (kind: 'draft' | 'pending') => {
    const raw = storage.getItem(`theoremos:issue-execution-${kind}:v1:${suffix}`);
    if (!raw) return;
    try { return JSON.parse(raw); } catch { return undefined; }
  };
  const draft: LegacyDraft | undefined = read('draft');
  const pending = read('pending') as { input?: LegacyDraft & { issueSource?: { issueId?: unknown } }; draft?: LegacyDraft } | undefined;
  const submitted = pending?.input?.issueSource?.issueId === scope.issueId ? pending.input : undefined;
  return [...new Set([draft?.text, draft?.objective, draft?.dependencies, submitted?.text,
    ...(submitted ? [pending?.draft?.text, pending?.draft?.objective, pending?.draft?.dependencies] : [])]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim())))];
}
