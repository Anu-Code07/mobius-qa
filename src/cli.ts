#!/usr/bin/env node
// mobius-qa run     <scenario.md|dir>... --device <id>   agent runs, evidence-verified; passing runs compile to replay scripts
// mobius-qa replay  <scenario.md|dir>... --device <id>   deterministic replays, no LLM
// mobius-qa monitor <scenario.md|dir>... --device <id> --every 15m [--slack <webhook>] [--once]
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkScenario, notify, withMobius, type CheckOutcome, type MonitorOptions } from './monitor.ts';
import { renderReport } from './report.ts';
import { compile, loadScript, replay, saveScript } from './replay.ts';
import { runScenario, type RunResult } from './runner.ts';
import { loadScenario } from './scenario.ts';

const here = dirname(fileURLToPath(import.meta.url));
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    device: { type: 'string' },
    platform: { type: 'string' },
    mobius: { type: 'string', default: process.env.MOBIUS_DIR ?? resolve(here, '../../mobius') },
    model: { type: 'string', default: process.env.QA_MODEL ?? 'claude-opus-5-5' },
    out: { type: 'string', default: 'runs' },
    scripts: { type: 'string', default: '.mobius-qa/replays' },
    // Live/production app: every approval is rejected, whatever the scenario says. Read-only testing.
    live: { type: 'boolean', default: false },
    every: { type: 'string', default: '15m' },
    slack: { type: 'string', default: process.env.MOBIUS_QA_SLACK_WEBHOOK },
    once: { type: 'boolean', default: false },
  },
});
const [cmd, ...targets] = positionals;
if (!['run', 'replay', 'monitor'].includes(cmd ?? '') || !targets.length || !values.device) {
  process.stderr.write('usage: mobius-qa run|replay|monitor <scenario.md|dir>... --device <id> [--platform android|ios] [--live] [--every 15m] [--slack <url>] [--once]\n');
  process.exit(2);
}
const platform = (values.platform ?? (/^[0-9A-F-]{36}$/i.test(values.device) ? 'ios' : 'android')) as 'android' | 'ios';
const device = { id: values.device, platform };
const files = targets.flatMap(t => statSync(t).isDirectory()
  ? readdirSync(t).filter(f => f.endsWith('.md')).sort().map(f => join(t, f)) : [t]);
const scenarios = files.map(loadScenario).filter(s => s.app[platform])
  .map(s => (values.live ? { ...s, approvals: 'rejected' as const } : s));
if (values.live) process.stderr.write('LIVE mode: all approvals will be rejected (no payments, bookings or sends can complete).\n');
const opts: MonitorOptions = { mobiusDir: values.mobius!, device, model: values.model!, scriptsDir: values.scripts!, live: values.live!, ...(values.slack ? { slackWebhook: values.slack } : {}) };

if (cmd === 'run') {
  const outDir = join(values.out!, new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(outDir, { recursive: true });
  const results: RunResult[] = [];
  for (const sc of scenarios) {
    process.stderr.write(`▶ ${sc.id} (${platform}) … `);
    try {
      const r = await runScenario(sc, { mobiusDir: opts.mobiusDir, device, model: opts.model });
      results.push(r);
      if (r.verdict.status === 'pass') saveScript(opts.scriptsDir, compile(r));
      process.stderr.write(`${r.verdict.status.toUpperCase()} · ${r.trace.length} actions · ${(r.durationMs / 1000).toFixed(0)}s · $${r.costUsd.toFixed(2)}${r.verdict.status === 'pass' ? ' · replay script saved' : ''}\n`);
    } catch (e) {
      process.stderr.write(`ERROR ${(e as Error).message}\n`);
      results.push({ scenario: sc, device, verdict: { status: 'error', summary: (e as Error).message, expectations: [], bugs: [] }, trace: [], costUsd: 0, turns: 0, durationMs: 0 });
    }
    writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
    writeFileSync(join(outDir, 'report.html'), renderReport(results));
  }
  process.stderr.write(`\nReport: ${resolve(outDir, 'report.html')}\n`);
  process.exit(results.every(r => r.verdict.status === 'pass') ? 0 : 1);
}

if (cmd === 'replay') {
  let ok = true;
  for (const sc of scenarios) {
    const script = loadScript(opts.scriptsDir, sc.id, platform);
    if (!script) { process.stderr.write(`▶ ${sc.id}: no replay script (run it once with \`mobius-qa run\`)\n`); ok = false; continue; }
    const r = await withMobius(opts, sc, call => replay(script, call));
    process.stderr.write(`▶ ${sc.id}: ${r.status.toUpperCase()} · ${r.steps_run}/${script.steps.length} steps · ${(r.duration_ms / 1000).toFixed(0)}s · $0.00 · ${r.reason}\n`);
    ok &&= r.status === 'pass';
  }
  process.exit(ok ? 0 : 1);
}

// monitor
const ms = (s: string) => { const m = /^(\d+)(s|m|h)$/.exec(s); if (!m) throw new Error(`--every: use 30s, 15m or 1h`); return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5 }[m[2] as 's' | 'm' | 'h']; };
const interval = ms(values.every!);
const last = new Map<string, CheckOutcome['status']>();
process.stderr.write(`Monitoring ${scenarios.length} journeys on ${platform} ${device.id} every ${values.every}${opts.slackWebhook ? ' · Slack alerts on' : ''}\n`);
for (;;) {
  for (const sc of scenarios) {
    let c: CheckOutcome;
    try { c = await checkScenario(sc, opts); }
    catch (e) { c = { scenario: sc.id, status: 'error', mode: 'replay', reason: (e as Error).message, cost_usd: 0, duration_ms: 0 }; }
    process.stderr.write(`${new Date().toISOString()} ${sc.id}: ${c.status.toUpperCase()} via ${c.mode} · $${c.cost_usd.toFixed(2)} · ${c.reason}\n`);
    await notify(opts, c, last.get(sc.id));
    last.set(sc.id, c.status);
  }
  if (values.once) break;
  await new Promise(r => setTimeout(r, interval));
}
process.exit([...last.values()].every(s => s === 'pass' || s === 'healed') ? 0 : 1);
