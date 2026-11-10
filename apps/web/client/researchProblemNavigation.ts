/** Keep a problem's exact destination when entering from an older workspace link. */
export function problemEntryHref(input: { runId: string; projectId?: string; href?: string; tab?: string }): string {
  const source = new URL(input.href ?? './', 'https://theoremos.local/');
  const query = new URLSearchParams({ run: input.runId });
  const project = input.projectId ?? source.searchParams.get('project') ?? (source.pathname.endsWith('theorems.html') ? source.searchParams.get('id') : undefined);
  if (project) query.set('project', project);
  for (const field of ['task', 'taskVersion', 'commit', 'compare', 'lang', 'decision', 'version', 'feedback', 'issue', 'revise']) {
    const value = source.searchParams.get(field); if (value) query.set(field, value);
  }
  query.set('tab', input.tab ?? (source.hash.startsWith('#feedback-') || source.hash.startsWith('#issue-') ? 'discussion'
    : source.searchParams.has('task') ? 'route' : 'overview'));
  return `problem.html?${query}${source.hash}`;
}
