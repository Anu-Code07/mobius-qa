// Monitor: watch production journeys on a schedule. Replay deterministically (no tokens); when the UI drifts, let the agent
// re-run the journey once, re-verify its evidence and recompile the script (self-healing). Alert only on real failures.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { compile, loadScript, replay, saveScript, type Call, type ReplayResult } from './replay.ts';
import { runScenario, type RunResult } from './runner.ts';
import type { Scenario } from './scenario.ts';
import type { Category } from './triage.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MonitorOptions {
  mobiusDir: string;
  device: { id: string; platform: 'android' | 'ios' };
  model: string;
  scriptsDir: string;
  slackWebhook?: string;
  /** Production apps: every approval is rejected, so nothing can be paid, booked or sent. */
  live: boolean;
}

export interface CheckOutcome {
  scenario: string;
  status: 'pass' | 'fail' | 'healed' | 'error';
  mode: 'replay' | 'agent';
  reason: string;
  cost_usd: number;
  duration_ms: number;
  run?: RunResult;
  replay?: ReplayResult;
}

/** One Mobius session for deterministic replays: the same safety gates as agent runs, no model. */
export async function withMobius<T>(o: MonitorOptions, sc: Scenario, fn: (call: Call) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'mobius-qa-replay', version: '0.1.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [`${o.mobiusDir}/packages/host/src/cli.ts`, 'mcp'], stderr: 'ignore',
    env: { ...process.env, MOBIUS_TEST_APPROVAL: o.live ? 'rejected' : sc.approvals, MOBIUS_DB: ':memory:' } as Record<string, string>,
  }));
  const call: Call = async (tool, args) => {
    const r: any = await client.callTool({ name: tool, arguments: { device_id: o.device.id, ...args } }, undefined, { timeout: 180_000 });
    const text = (r.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    let json: any = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
    const img = (r.content ?? []).find((c: any) => c.type === 'image');
    return { text, json, ...(img ? { image: { data: img.data, mimeType: img.mimeType } } : {}) };
  };
  try { return await fn(call); } finally { await client.close(); }
}

export async function checkScenario(sc: Scenario, o: MonitorOptions): Promise<CheckOutcome> {
  const t0 = Date.now();
  const script = loadScript(o.scriptsDir, sc.id, o.device.platform);
  let rep: ReplayResult | undefined;
  if (script) {
    rep = await withMobius(o, sc, call => replay(script, call));
    if (rep.status !== 'drift') {
      return { scenario: sc.id, status: rep.status, mode: 'replay', reason: rep.reason, cost_usd: 0, duration_ms: Date.now() - t0, replay: rep };
    }
  }
  // No script yet, or the UI drifted: the agent walks the journey again (evidence-verified), then we recompile.
  const run = await runScenario(o.live ? { ...sc, approvals: 'rejected' } : sc, { mobiusDir: o.mobiusDir, device: o.device, model: o.model });
  if (run.verdict.status === 'pass') saveScript(o.scriptsDir, compile(run));
  const status = run.verdict.status === 'pass' ? (script ? 'healed' : 'pass') : run.verdict.status === 'fail' ? 'fail' : 'error';
  const reason = script ? `UI drift (${rep!.reason}); agent re-ran: ${run.verdict.summary}` : run.verdict.summary;
  return { scenario: sc.id, status, mode: 'agent', reason, cost_usd: run.costUsd, duration_ms: Date.now() - t0, run, ...(rep ? { replay: rep } : {}) };
}

/** Save the failure screenshot next to the run, for the alert and the ticket. */
export function saveFailureShot(dir: string, c: CheckOutcome): string | null {
  const img = c.replay?.failure_screenshot;
  if (!img) return null;
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${c.scenario}-${new Date().toISOString().replace(/[:.]/g, '-')}.${img.mimeType.includes('png') ? 'png' : 'jpg'}`);
  writeFileSync(f, Buffer.from(img.data, 'base64'));
  return f;
}

/**
 * Alert on transitions only, and only for real problems: a confirmed bug pages; recovery is announced;
 * flakes and self-healed UI changes never page (they show up in the log and the release-guard summary).
 */
export async function notify(o: MonitorOptions, c: CheckOutcome, category: Category, prev: Category | undefined, extra: { jira?: string | null; shot?: string | null } = {}) {
  const bad = category === 'bug';
  const wasBad = prev === 'bug';
  if (bad === wasBad || !o.slackWebhook) return;
  const text = bad
    ? `:rotating_light: *${c.scenario}* is broken on ${o.device.platform} (${o.device.id}), confirmed on retry: ${c.reason}` +
      (extra.jira ? `\nJira: ${extra.jira}` : '') + (extra.shot ? `\nScreenshot: ${extra.shot}` : '')
    : `:white_check_mark: *${c.scenario}* recovered on ${o.device.platform}: ${c.reason}`;
  await fetch(o.slackWebhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }).catch(() => {});
}
