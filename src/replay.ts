// Explore once, replay forever: compile a verified agent run into a deterministic script, then re-run it through Mobius with
// zero LLM tokens. Elements are found again by what they are (role + text/label/id), not by per-screen ids, so ordinary
// re-renders replay fine; a missing element is "drift" (the UI changed) and hands control back to the agent to heal.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult, TraceStep } from './runner.ts';

export interface Selector { role: string; text: string | null; label: string | null; rid: string | null }
export interface ReplayStep {
  tool: string;
  args: Record<string, unknown>;
  target?: Selector;
  /** The recorded run ended this step with a safety stop (e.g. APPROVAL_REJECTED); replay must see the same stop. */
  expect_error?: string;
}
export interface ReplayScript {
  scenario: string;
  platform: 'android' | 'ios';
  app: string;
  compiled_at: string;
  steps: ReplayStep[];
  /** Verbatim quotes the verified run saw, per expectation; the replay must see them all again. */
  checks: { expectation: string; quotes: string[] }[];
}

const ACTIONS = new Set(['open_app', 'open_url', 'tap', 'type', 'scroll', 'swipe', 'press_key', 'wait_for']);
const SAFETY_STOPS = new Set(['APPROVAL_REJECTED', 'APPROVAL_EXPIRED', 'POLICY_BLOCKED']);

/** First JSON object in a tool output (outputs may carry a leading note). */
export function parseOut(output: string): any {
  const i = output.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(output.slice(i)); } catch { return null; }
}
const errCode = (out: any): string | null => out?.error?.code ?? null;

/** Compile a run whose verdict passed evidence verification. Agent detours (failed, retried actions) are dropped. */
export function compile(run: RunResult): ReplayScript {
  if (run.verdict.status !== 'pass') throw new Error(`${run.scenario.id}: only verified passing runs compile (status ${run.verdict.status})`);
  const elements = new Map<string, any>();
  const steps: ReplayStep[] = [];
  for (const s of run.trace) {
    const out = parseOut(s.output);
    if (s.tool === 'observe') {
      for (const e of out?.elements ?? []) elements.set(e.id, e);
      continue;
    }
    if (!ACTIONS.has(s.tool)) continue;
    const code = errCode(out);
    const failed = s.isError || out?.ok === false;
    if (failed && !(code && SAFETY_STOPS.has(code))) continue; // agent mistake it recovered from: not part of the journey
    const { device_id: _d, element_id, ...args } = (s.input ?? {}) as Record<string, unknown>;
    const step: ReplayStep = { tool: s.tool, args };
    if (typeof element_id === 'string') {
      const e = elements.get(element_id);
      if (!e) continue; // can't name it again: drop rather than guess
      step.target = { role: e.role, text: e.text ?? null, label: e.label ?? null, rid: e.rid ?? e.resource_id ?? null };
    }
    if (failed) step.expect_error = code!;
    steps.push(step);
  }
  return {
    scenario: run.scenario.id, platform: run.device.platform, app: run.scenario.app[run.device.platform]!,
    compiled_at: new Date().toISOString(), steps,
    checks: run.verdict.expectations.map(e => ({ expectation: e.text, quotes: e.evidence.map(x => x.quote) })),
  };
}

const same = (a: string | null, b: string | null | undefined) => (a ?? null) === (b ?? null);
/** Exact identity first; then same role + any one stable field (text, label, id). Ambiguous = no match. */
export function findElement(elements: any[], sel: Selector): any | null {
  const exact = elements.filter(e => e.role === sel.role && same(sel.text, e.text) && same(sel.label, e.label) && same(sel.rid, e.rid ?? e.resource_id));
  if (exact.length) return exact[0];
  const keys: (keyof Selector)[] = ['rid', 'text', 'label'];
  for (const k of keys) {
    if (!sel[k]) continue;
    const hits = elements.filter(e => e.role === sel.role && (k === 'rid' ? (e.rid ?? e.resource_id) : e[k]) === sel[k]);
    if (hits.length === 1) return hits[0];
  }
  return null;
}

export type Call = (tool: string, args: Record<string, unknown>) => Promise<{ text: string; json: any }>;
export interface ReplayResult {
  status: 'pass' | 'fail' | 'drift';
  reason: string;
  steps_run: number;
  missing_quotes: string[];
  duration_ms: number;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[“”"']/g, '');

/** Run a script. No model involved: cost is device time only. */
export async function replay(script: ReplayScript, call: Call, waitMs = 600): Promise<ReplayResult> {
  const t0 = Date.now();
  const seen: string[] = [];
  const done = (status: ReplayResult['status'], reason: string, i: number, missing: string[] = []): ReplayResult =>
    ({ status, reason, steps_run: i, missing_quotes: missing, duration_ms: Date.now() - t0 });
  for (let i = 0; i < script.steps.length; i++) {
    const st = script.steps[i]!;
    const args: Record<string, unknown> = { ...st.args };
    if (st.target) {
      const obs = await call('observe', {});
      seen.push(obs.text);
      const e = findElement(obs.json?.elements ?? [], st.target);
      if (!e) return done('drift', `step ${i + 1} ${st.tool}: no element like ${JSON.stringify(st.target)} on screen`, i);
      args.element_id = e.id;
    }
    const r = await call(st.tool, args);
    seen.push(r.text);
    const code = errCode(r.json);
    if (st.expect_error) {
      // A safety stop that no longer happens is the worst regression there is: the journey would now pay/send.
      if (code !== st.expect_error) return done('fail', `step ${i + 1} ${st.tool}: expected ${st.expect_error}, got ${code ?? 'success'}`, i + 1);
    } else if (r.json?.ok === false) {
      return done(code === 'ELEMENT_NOT_FOUND' || code === 'STALE_ELEMENT' || code === 'AMBIGUOUS_TARGET' ? 'drift' : 'fail',
        `step ${i + 1} ${st.tool}: ${code ?? 'failed'} ${r.json?.message ?? ''}`.trim(), i + 1);
    }
    await new Promise(res => setTimeout(res, waitMs));
  }
  seen.push((await call('observe', {})).text);
  const all = norm(seen.join('\n'));
  const missing = script.checks.flatMap(c => c.quotes).filter(q => !all.includes(norm(q)));
  return missing.length ? done('fail', `expected evidence not seen: ${missing.map(q => `"${q}"`).join(', ')}`, script.steps.length, missing)
    : done('pass', `all ${script.checks.length} expectations re-verified`, script.steps.length);
}

export const scriptPath = (dir: string, id: string, platform: string) => join(dir, `${id}.${platform}.json`);
export function saveScript(dir: string, s: ReplayScript) { mkdirSync(dir, { recursive: true }); writeFileSync(scriptPath(dir, s.scenario, s.platform), JSON.stringify(s, null, 2)); }
export function loadScript(dir: string, id: string, platform: string): ReplayScript | null {
  const p = scriptPath(dir, id, platform);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

export type { TraceStep };
