#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { allowlistFile, WebAuth } from '../apps/web/auth';
import { webFunnel, type WebFunnel } from '../apps/web/funnel';
import { WebStorage } from '../apps/web/storage';

export { webFunnel, type WebFunnel, type WebFunnelStep } from '../apps/web/funnel';

/**
 * Closed-beta funnel: applications → allowlisted → first login → first submitted run → first accepted run.
 * Reads the workbench data root and prints totals only, never an address. Accounts created before the milestones were
 * recorded count as logged in but not as having submitted.
 *
 *   bun scripts/web-funnel.ts --data /var/lib/theorem-os [--applications 12] [--github] [--json]
 *
 * --applications adds requests that arrived by email; --github adds early-access issues on the public site repository
 * (read with the gh CLI). Without either, the funnel starts at the allowlist.
 */
const labels: Record<string, string> = { applied: '申请内测', allowlisted: '加入白名单', logged_in: '首次登录', submitted: '首次提交运行', accepted: '首次通过验收' };
export function formatWebFunnel(funnel: WebFunnel): string {
  const lines = funnel.steps.map(step => `${labels[step.step]!.padEnd(8, '　')} ${String(step.count).padStart(5)}${step.ofPrevious === undefined ? '' : `  ${step.ofPrevious}%`}`);
  const { loginToRun, runToAccepted } = funnel.medianHours;
  if (loginToRun !== undefined) lines.push(`登录到首次提交（中位数） ${loginToRun} 小时`);
  if (runToAccepted !== undefined) lines.push(`首次提交到首次通过（中位数） ${runToAccepted} 小时`);
  return lines.join('\n');
}

if (import.meta.main) {
  const args = process.argv.slice(2), value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const dataRoot = value('--data') ?? process.env.THEOREMOS_WEB_DATA_ROOT;
  if (!dataRoot) throw new Error('Pass --data <THEOREMOS_WEB_DATA_ROOT>.');
  const manual = value('--applications');
  if (manual !== undefined && !/^\d+$/u.test(manual)) throw new Error('--applications takes a whole number.');
  let applications = manual === undefined ? undefined : Number(manual);
  if (args.includes('--github')) {
    const issues = JSON.parse(execFileSync('gh', ['issue', 'list', '--repo', 'HuggingMath/TheoremOS', '--label', 'early-access',
      '--state', 'all', '--limit', '1000', '--json', 'number'], { encoding: 'utf8' })) as unknown[];
    applications = (applications ?? 0) + issues.length;
  }
  const root = path.resolve(dataRoot);
  // WebStorage creates a missing root; a mistyped path would otherwise report an empty beta.
  if (!fs.existsSync(path.join(root, 'accounts')) && !fs.existsSync(allowlistFile(root)!)) throw new Error(`No workbench accounts or allowlist under ${root}.`);
  const list = (value?: string) => (value ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  const auth = new WebAuth({ smtpUrl: 'log:', from: '', allowlist: list(process.env.THEOREMOS_WEB_ALLOWLIST), admins: list(process.env.THEOREMOS_WEB_ADMINS),
    allowlistFile: process.env.THEOREMOS_WEB_ALLOWLIST_FILE ?? allowlistFile(root) }, new WebStorage(root), async () => undefined);
  const funnel = webFunnel(auth.listAccounts(), auth.allowlist(), applications);
  console.log(args.includes('--json') ? JSON.stringify(funnel, null, 2) : formatWebFunnel(funnel));
}
