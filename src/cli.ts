#!/usr/bin/env node
// mobius-qa run <scenario.md|dir>... --device <id> [--platform android|ios] [--mobius <path>] [--model <id>]
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { renderReport } from './report.ts';
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
    // Live/production app: every approval is rejected, whatever the scenario says. Read-only testing.
    live: { type: 'boolean', default: false },
  },
});
const [cmd, ...targets] = positionals;
if (cmd !== 'run' || !targets.length || !values.device) {
  process.stderr.write('usage: mobius-qa run <scenario.md|dir>... --device <id> [--platform android|ios] [--mobius <dir>] [--model <id>]\n');
  process.exit(2);
}
const platform = (values.platform ?? (/^[0-9A-F-]{36}$/i.test(values.device) ? 'ios' : 'android')) as 'android' | 'ios';
const files = targets.flatMap(t => statSync(t).isDirectory()
  ? readdirSync(t).filter(f => f.endsWith('.md')).sort().map(f => join(t, f)) : [t]);
const scenarios = files.map(loadScenario).filter(s => s.app[platform])
  .map(s => (values.live ? { ...s, approvals: 'rejected' as const } : s));
if (values.live) process.stderr.write('LIVE mode: all approvals will be rejected (no payments, bookings or sends can complete).\n');

const outDir = join(values.out!, new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(outDir, { recursive: true });
const results: RunResult[] = [];
for (const sc of scenarios) {
  process.stderr.write(`▶ ${sc.id} (${platform}) … `);
  try {
    const r = await runScenario(sc, { mobiusDir: values.mobius!, device: { id: values.device, platform }, model: values.model! });
    results.push(r);
    process.stderr.write(`${r.verdict.status.toUpperCase()} · ${r.trace.length} actions · ${(r.durationMs / 1000).toFixed(0)}s · $${r.costUsd.toFixed(2)}\n`);
  } catch (e) {
    process.stderr.write(`ERROR ${(e as Error).message}\n`);
    results.push({ scenario: sc, device: { id: values.device, platform }, verdict: { status: 'error', summary: (e as Error).message, expectations: [], bugs: [] }, trace: [], costUsd: 0, turns: 0, durationMs: 0 });
  }
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  writeFileSync(join(outDir, 'report.html'), renderReport(results));
}
process.stderr.write(`\nReport: ${resolve(outDir, 'report.html')}\n`);
process.exit(results.every(r => r.verdict.status === 'pass') ? 0 : 1);
