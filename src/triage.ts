// Stage 4: triage before alerting. A failure is retried once; the pair of outcomes says what kind of failure it is.
//   bug       – failed twice the same way: page someone, file a ticket
//   flake     – failed, then passed: record, don't page
//   ui_change – the UI drifted and the agent healed the journey: informational
//   infra     – device, agent or harness trouble: not the app's fault
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CheckOutcome } from './monitor.ts';

export type Category = 'ok' | 'bug' | 'flake' | 'ui_change' | 'infra';

/** Decide from the first outcome and, for failures, one retry. */
export function categorize(first: CheckOutcome, retry?: CheckOutcome): Category {
  if (first.status === 'pass') return 'ok';
  if (first.status === 'healed') return 'ui_change';
  if (first.status === 'error') return retry && (retry.status === 'pass' || retry.status === 'healed') ? 'flake' : 'infra';
  // fail
  if (!retry) return 'bug';
  if (retry.status === 'pass' || retry.status === 'healed') return 'flake';
  if (retry.status === 'error') return 'infra';
  return 'bug';
}

export async function triage(check: () => Promise<CheckOutcome>): Promise<{ outcome: CheckOutcome; category: Category; retried: boolean }> {
  const first = await check().catch(e => errorOutcome(e));
  if (first.status === 'pass' || first.status === 'healed') return { outcome: first, category: categorize(first), retried: false };
  const retry = await check().catch(e => errorOutcome(e));
  return { outcome: retry.status === 'fail' ? retry : first, category: categorize(first, retry), retried: true };
}
const errorOutcome = (e: unknown): CheckOutcome => ({ scenario: '?', status: 'error', mode: 'replay', reason: (e as Error).message, cost_usd: 0, duration_ms: 0 });

export interface JiraConfig { url: string; email: string; token: string; project: string; issueType?: string }
export const jiraFromEnv = (): JiraConfig | null => {
  const { JIRA_URL: url, JIRA_EMAIL: email, JIRA_API_TOKEN: token, JIRA_PROJECT: project } = process.env;
  return url && email && token && project ? { url: url.replace(/\/$/, ''), email, token, project, ...(process.env.JIRA_ISSUE_TYPE ? { issueType: process.env.JIRA_ISSUE_TYPE } : {}) } : null;
};

/** The ticket body: what broke, how to reproduce (the replay steps), and the evidence. */
export function ticketFor(c: CheckOutcome, platform: string, device: string, steps: string[]): { summary: string; body: string } {
  const summary = `[mobius-qa] ${c.scenario} failing on ${platform}: ${c.reason.slice(0, 120)}`;
  const body = [
    `Journey "${c.scenario}" failed twice in a row on ${platform} (${device}). Detected by mobius-qa monitoring; no payment, booking or message was made.`,
    `What failed: ${c.reason}`,
    steps.length ? `Steps to reproduce:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '',
    c.replay?.missing_quotes.length ? `Expected but not seen on screen: ${c.replay.missing_quotes.map(q => `"${q}"`).join(', ')}` : '',
  ].filter(Boolean).join('\n\n');
  return { summary, body };
}

/** File one Jira issue per distinct failure (deduped across runs by a local ledger). Returns the issue key, or null. */
export async function fileJira(cfg: JiraConfig, t: { summary: string; body: string }, ledgerPath: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const key = createHash('sha1').update(t.summary).digest('hex').slice(0, 16);
  const ledger: Record<string, string> = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : {};
  if (ledger[key]) return ledger[key]!;
  const r = await fetchFn(`${cfg.url}/rest/api/3/issue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64')}` },
    body: JSON.stringify({ fields: {
      project: { key: cfg.project }, issuetype: { name: cfg.issueType ?? 'Bug' }, summary: t.summary, labels: ['mobius-qa'],
      description: { type: 'doc', version: 1, content: t.body.split('\n\n').map(p => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })) },
    } }),
  });
  if (!r.ok) return null;
  const issue = (await r.json()) as { key?: string };
  if (!issue.key) return null;
  ledger[key] = issue.key;
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
  return issue.key;
}
