#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { allowlistFile, WebAuth, type WebAccount } from '../apps/web/auth';
import { WebStorage } from '../apps/web/storage';

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
export type WebFunnelStep = { step: string; count: number; ofPrevious?: number };
export type WebFunnel = { steps: WebFunnelStep[]; medianHours: { loginToRun?: number; runToAccepted?: number } };

const hours = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 3_600_000;
const median = (values: number[]) => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  const value = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return Math.round(value * 10) / 10;
};

export function webFunnel(accounts: WebAccount[], allowlist: Set<string>, applications?: number): WebFunnel {
  // Accounts whose address left the allowlist still count: they were admitted and logged in.
  const admitted = new Set([...allowlist, ...accounts.map(account => account.email)]);
  const ran = accounts.filter(account => account.firstRunAt), accepted = ran.filter(account => account.firstAcceptedAt);
  const counts: [string, number][] = [
    ...(applications === undefined ? [] : [['applied', applications] as [string, number]]),
    ['allowlisted', admitted.size], ['logged_in', accounts.length], ['submitted', ran.length], ['accepted', accepted.length],
  ];
  const steps = counts.map(([step, count], index) => {
    const previous = index ? counts[index - 1]![1] : undefined;
    return { step, count, ...(previous ? { ofPrevious: Math.round(count / previous * 1000) / 10 } : {}) };
  });
  return { steps, medianHours: {
    loginToRun: median(ran.map(account => hours(account.createdAt, account.firstRunAt!))),
    runToAccepted: median(accepted.map(account => hours(account.firstRunAt!, account.firstAcceptedAt!))),
  } };
}

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
    const issues = JSON.parse(execFileSync('gh', ['issue', 'list', '--repo', 'LikC1606/theorem-os-site', '--label', 'early-access',
      '--state', 'all', '--limit', '1000', '--json', 'number'], { encoding: 'utf8' })) as unknown[];
    applications = (applications ?? 0) + issues.length;
  }
  const root = path.resolve(dataRoot);
  // WebStorage creates a missing root; a mistyped path would otherwise report an empty beta.
  if (!fs.existsSync(path.join(root, 'accounts')) && !fs.existsSync(allowlistFile(root)!)) throw new Error(`No workbench accounts or allowlist under ${root}.`);
  const auth = new WebAuth({ smtpUrl: 'log:', from: '', allowlist: (process.env.THEOREMOS_WEB_ALLOWLIST ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean),
    allowlistFile: process.env.THEOREMOS_WEB_ALLOWLIST_FILE ?? allowlistFile(root) }, new WebStorage(root), async () => undefined);
  const funnel = webFunnel(auth.listAccounts(), auth.allowlist(), applications);
  console.log(args.includes('--json') ? JSON.stringify(funnel, null, 2) : formatWebFunnel(funnel));
}
