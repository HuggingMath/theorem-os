/** Public archives request access; the bundled classic library returns to the real workbench. */
export function archiveStudyDestination(locale: 'zh' | 'en', recordId: string, workbenchRoot?: string) {
  const workbench = workbenchRoot === '../' || workbenchRoot === '../../';
  return { href: workbench ? `${workbenchRoot}?${new URLSearchParams({ fromClassic: recordId, lang: locale })}` : 'index.html#start',
    label: workbench ? locale === 'en' ? 'Prepare my own research' : '准备自己的研究' : locale === 'en' ? 'Request access' : '申请内测' };
}
