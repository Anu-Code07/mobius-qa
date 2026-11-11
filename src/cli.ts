#!/usr/bin/env node
// mobius-qa run     <scenario.md|dir>... --device <id>   agent runs, evidence-verified; passing runs compile to replay scripts
// mobius-qa replay  <scenario.md|dir>... --device <id>   deterministic replays, no LLM
// mobius-qa monitor <scenario.md|dir>... --device <id> --every 15m [--slack <webhook>] [--once]   (Jira via JIRA_* env)
// mobius-qa guard   <scenario.md|dir>... --device <id> --build <version>                     exit 1 = block the rollout
// mobius-qa discover --app <id> --device <id> [--out scenarios/proposed]                     propose journeys to watch
// mobius-qa fleet    --manifest qa/fleet.json --devices <id,id,...> [--suite all|a,b] [--install]   central runner
// mobius-qa release  --artifact app.apk|.ipa [--notes <fastlane metadata>] [--guard <scenarios> --device <id>] [--shipped]
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkScenario, notify, saveFailureShot, withMobius, type MonitorOptions } from './monitor.ts';
import { discover, writeProposals } from './discover.ts';
import { compare, lastGoodBuild, saveBuild, summary, type BuildRecord, type GuardVerdict } from './guard.ts';
import { MAESTRO_INFRA, acquireDevice, assemble, loadManifest, releaseDevice, runHook, runMaestro, shard, suiteSummary, type JobResult } from './fleet.ts';
import { categorize } from './triage.ts';
import type { Scenario } from './scenario.ts';
import { basename } from 'node:path';
import { DEFAULT_RELEASE, decision, evaluate, lastRelease, notesPresent, readArtifact, report, saveRelease } from './release.ts';
import { fileJira, jiraFromEnv, ticketFor, triage, type Category } from './triage.ts';
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
    build: { type: 'string' },
    history: { type: 'string', default: '.mobius-qa/builds' },
    summary: { type: 'string' },
    app: { type: 'string' },
    budget: { type: 'string', default: '3' },
    artifact: { type: 'string' },
    notes: { type: 'string' },
    guard: { type: 'string', multiple: true },
    releases: { type: 'string', default: '.mobius-qa/releases' },
    shipped: { type: 'boolean', default: false },
    manifest: { type: 'string' },
    devices: { type: 'string' },
    suite: { type: 'string', default: 'all' },
    install: { type: 'boolean', default: false },
  },
});
const [cmd, ...targets] = positionals;

if (cmd === 'fleet') {
  // Central runner: suites from many repos, one install per device, journeys sharded over a locked device pool.
  if (!values.manifest || !values.devices) { process.stderr.write('usage: mobius-qa fleet --manifest qa/fleet.json --devices <id,id,...> [--suite all|a,b] [--platform android|ios] [--install] [--slack <url>]\n'); process.exit(2); }
  const m = loadManifest(values.manifest);
  const jobs = assemble(m, values.suite === 'all' ? 'all' : values.suite!.split(','));
  const want = values.devices.split(',').map(d => d.trim()).filter(Boolean);
  const plat = (values.platform ?? (m.app.android ? 'android' : 'ios')) as 'android' | 'ios';
  const appId = m.app[plat];
  if (!appId) { process.stderr.write(`manifest has no app.${plat}\n`); process.exit(2); }
  const live = m.live !== false;
  const fopts = (id: string): MonitorOptions => ({ mobiusDir: values.mobius!, device: { id, platform: plat }, model: values.model!, scriptsDir: values.scripts!, live, ...(values.slack ? { slackWebhook: values.slack } : {}) });

  // Preflight: lock each device, confirm Mobius sees it online, install/build if asked, confirm the app is there.
  const pool: string[] = [];
  const probe = { approvals: 'rejected' } as Scenario;
  for (const id of want) {
    if (!acquireDevice(id, `fleet ${process.pid}`)) { process.stderr.write(`⏭  ${id}: busy (locked by another run)\n`); continue; }
    pool.push(id);
  }
  const release = () => pool.forEach(id => releaseDevice(id));
  process.on('SIGINT', () => { release(); process.exit(130); });
  process.on('SIGTERM', () => { release(); process.exit(143); });
  try {
    const listed = await withMobius(fopts(pool[0] ?? want[0]!), probe, async call => (await call('device_list', {})).json?.devices ?? []);
    for (const id of [...pool]) {
      const d = listed.find((x: any) => x.device_id === id);
      if (!d?.online) { process.stderr.write(`⏭  ${id}: not online (Mobius sees: ${listed.map((x: any) => x.device_id).join(', ') || 'none'})\n`); pool.splice(pool.indexOf(id), 1); releaseDevice(id); }
    }
    if (values.install && m.install) {
      const res = await Promise.all(pool.map(async id => ({ id, ...(await runHook(m.install!, { DEVICE: id, PLATFORM: plat })) })));
      for (const r of res) if (!r.ok) { process.stderr.write(`⏭  ${r.id}: install failed\n${r.out}\n`); pool.splice(pool.indexOf(r.id), 1); releaseDevice(r.id); }
    }
    for (const id of [...pool]) {
      const apps = await withMobius(fopts(id), probe, async call => (await call('list_apps', {})).text);
      if (!apps.includes(appId)) { process.stderr.write(`⏭  ${id}: ${appId} not installed (use --install with an "install" hook)\n`); pool.splice(pool.indexOf(id), 1); releaseDevice(id); }
    }
    if (!pool.length) { process.stderr.write('No usable devices.\n'); process.exit(2); }
    process.stderr.write(`Fleet: ${jobs.length} journeys · ${new Set(jobs.map(j => j.suite)).size} suites · ${pool.length} devices (${pool.join(', ')})${live ? ' · LIVE: every approval rejected' : ''}\n`);

    const results = await shard(jobs, pool, async (job, id): Promise<JobResult> => {
      const t0 = Date.now();
      const retries = m.retries?.[job.suite] ?? 1;
      if (job.kind === 'maestro') {
        let r = await runMaestro(job.file, id, appId), tries = 0, first = r.ok;
        while (!r.ok && tries++ < retries) r = await runMaestro(job.file, id, appId);
        const category: Category = r.ok ? (first ? 'ok' : 'flake') : MAESTRO_INFRA.test(r.out) ? 'infra' : 'bug';
        const res = { job, device: id, category, reason: r.ok ? 'passed' : (r.out.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300) || 'failed'), duration_ms: Date.now() - t0, cost_usd: 0 };
        process.stderr.write(`▶ [${id}] ${job.suite}/${basename(job.file)}: ${category.toUpperCase()}\n`);
        return res;
      }
      const sc = { ...loadScenario(job.file), ...(live ? { approvals: 'rejected' as const } : {}) };
      const o = fopts(id);
      const t = retries === 0 ? await (async () => { const c = await checkScenario(sc, o); return { outcome: c, category: categorize(c), retried: false }; })()
        : await triage(() => checkScenario(sc, o));
      const shot = t.category === 'bug' ? saveFailureShot(join(values.out!, 'screenshots', job.suite), t.outcome) : null;
      process.stderr.write(`▶ [${id}] ${job.suite}/${sc.id}: ${t.category.toUpperCase()} via ${t.outcome.mode} · $${t.outcome.cost_usd.toFixed(2)}\n`);
      return { job, device: id, category: t.category, reason: t.outcome.reason, duration_ms: Date.now() - t0, cost_usd: t.outcome.cost_usd, shot };
    });
    const text = suiteSummary(results);
    mkdirSync(values.out!, { recursive: true });
    writeFileSync(join(values.out!, 'fleet-results.json'), JSON.stringify(results, null, 2));
    process.stdout.write(text + '\n');
    if (values.slack) await fetch(values.slack, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }).catch(() => {});
    process.exitCode = results.some(r => r.category === 'bug') ? 1 : 0;
  } finally { release(); }
  process.exit(process.exitCode ?? 0);
}

if (cmd === 'release') {
  // Release manager: build checks + last-release diff + real journeys (optional) + manual checklist + rollout plan.
  if (!values.artifact) { process.stderr.write('usage: mobius-qa release --artifact app.apk|app.ipa [--notes <dir>] [--guard <scenarios> --device <id>] [--shipped]\n'); process.exit(2); }
  const facts = readArtifact(values.artifact);
  const prev = lastRelease(values.releases!, facts.platform, facts.id);
  let guardV: GuardVerdict | null = null;
  if (values.guard?.length) {
    if (!values.device) { process.stderr.write('--guard needs --device\n'); process.exit(2); }
    const gs = values.guard.flatMap(t => statSync(t).isDirectory() ? readdirSync(t).filter(f => f.endsWith('.md')).sort().map(f => join(t, f)) : [t])
      .map(loadScenario).filter(s => s.app[facts.platform]).map(s => ({ ...s, approvals: 'rejected' as const }));
    const gopts: MonitorOptions = { mobiusDir: values.mobius!, device: { id: values.device, platform: facts.platform }, model: values.model!, scriptsDir: values.scripts!, live: true };
    const rec: BuildRecord = { build: `${facts.version_name}+${facts.version_code}`, platform: facts.platform, at: new Date().toISOString(), journeys: [] };
    for (const sc of gs) {
      const t = await triage(() => checkScenario(sc, gopts));
      rec.journeys.push({ scenario: sc.id, status: t.outcome.status, category: t.category, reason: t.outcome.reason, duration_ms: t.outcome.duration_ms,
        step_ms: t.outcome.replay?.reliability.step_ms ?? [], unlabeled_controls: t.outcome.replay?.reliability.accessibility.unlabeled_controls ?? 0 });
      process.stderr.write(`▶ ${sc.id}: ${t.category.toUpperCase()} · ${t.outcome.reason}\n`);
    }
    const base = lastGoodBuild(values.history!, facts.platform, rec.build);
    saveBuild(values.history!, rec);
    guardV = compare(rec, base);
  }
  const cfg = DEFAULT_RELEASE;
  const items = evaluate(facts, prev, guardV, cfg, values.notes ? notesPresent(values.notes, facts, cfg.notes_locales) : null);
  const md = report(facts, items, cfg);
  process.stdout.write(md + '\n');
  if (values.summary) writeFileSync(values.summary, md);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, { flag: 'a' });
  if (values.shipped) { saveRelease(values.releases!, facts); process.stderr.write(`Recorded ${facts.version_name} (${facts.version_code}) as the last release for future comparisons.\n`); }
  process.exit(decision(items) === 'GO' ? 0 : 1);
}
const ok = cmd === 'discover' ? !!values.app && !!values.device : ['run', 'replay', 'monitor', 'guard'].includes(cmd ?? '') && targets.length && !!values.device && (cmd !== 'guard' || !!values.build);
if (!ok) {
  process.stderr.write([
    'usage: mobius-qa run|replay|monitor <scenario.md|dir>... --device <id> [--platform android|ios] [--live] [--every 15m] [--slack <url>] [--once]',
    '       mobius-qa guard <scenario.md|dir>... --device <id> --build <version> [--summary <file.md>]',
    '       mobius-qa discover --app <app-id> --device <id> [--out scenarios/proposed] [--budget 3]', ''].join('\n'));
  process.exit(2);
}
const platform = (values.platform ?? (/^[0-9A-F-]{36}$/i.test(values.device!) ? 'ios' : 'android')) as 'android' | 'ios';
const device = { id: values.device!, platform };

if (cmd === 'discover') {
  process.stderr.write(`Exploring ${values.app} on ${platform} ${device.id} (every approval rejected: nothing can be bought or sent)…\n`);
  const { proposals, costUsd } = await discover({ mobiusDir: values.mobius!, device, app: values.app!, model: values.model!, budgetUsd: Number(values.budget), maxTurns: 80 });
  const dir = values.out === 'runs' ? 'scenarios/proposed' : values.out!;
  const files = writeProposals(dir, proposals, platform, values.app!);
  for (const p of proposals) process.stderr.write(`  [${p.priority}] ${p.id}: ${p.title}: ${p.why}\n`);
  process.stderr.write(`\n${files.length} proposed journeys in ${dir}/ ($${costUsd.toFixed(2)}). Review, keep the ones worth watching, then: mobius-qa run ${dir} --device ${device.id}\n`);
  process.exit(0);
}
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

const jira = jiraFromEnv();
const shotsDir = join(values.out!, 'screenshots');

if (cmd === 'guard') {
  // Stage 3: run every journey against this build, triage failures, compare with the last good build.
  const rec: BuildRecord = { build: values.build!, platform, at: new Date().toISOString(), journeys: [] };
  for (const sc of scenarios) {
    const t = await triage(() => checkScenario(sc, opts));
    const c = t.outcome;
    rec.journeys.push({ scenario: sc.id, status: c.status, category: t.category, reason: c.reason, duration_ms: c.duration_ms,
      step_ms: c.replay?.reliability.step_ms ?? [], unlabeled_controls: c.replay?.reliability.accessibility.unlabeled_controls ?? 0 });
    if (t.category === 'bug') saveFailureShot(shotsDir, c);
    process.stderr.write(`▶ ${sc.id}: ${t.category.toUpperCase()}${t.retried ? ' (retried)' : ''} · ${c.reason}\n`);
  }
  const base = lastGoodBuild(values.history!, platform, rec.build);
  saveBuild(values.history!, rec);
  const v = compare(rec, base);
  const md = summary(rec, base, v);
  process.stdout.write(md + '\n');
  if (values.summary) writeFileSync(values.summary, md);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, { flag: 'a' });
  process.exit(v.block ? 1 : 0);
}

// monitor
const ms = (s: string) => { const m = /^(\d+)(s|m|h)$/.exec(s); if (!m) throw new Error(`--every: use 30s, 15m or 1h`); return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5 }[m[2] as 's' | 'm' | 'h']; };
const interval = ms(values.every!);
const last = new Map<string, Category>();
process.stderr.write(`Monitoring ${scenarios.length} journeys on ${platform} ${device.id} every ${values.every}${opts.slackWebhook ? ' · Slack alerts' : ''}${jira ? ' · Jira tickets' : ''}\n`);
for (;;) {
  for (const sc of scenarios) {
    const t = await triage(() => checkScenario(sc, opts));
    const c = t.outcome;
    const rel = c.replay?.reliability;
    const slowest = rel?.step_ms.slice().sort((a, b) => b.ms - a.ms)[0];
    process.stderr.write(`${new Date().toISOString()} ${sc.id}: ${t.category.toUpperCase()} via ${c.mode}${t.retried ? ' (retried)' : ''} · $${c.cost_usd.toFixed(2)}` +
      `${slowest ? ` · slowest step ${slowest.target || slowest.tool} ${(slowest.ms / 1000).toFixed(1)}s` : ''}` +
      `${rel?.accessibility.unlabeled_controls ? ` · ${rel.accessibility.unlabeled_controls} unlabeled controls` : ''} · ${c.reason}\n`);
    let jiraKey: string | null = null, shot: string | null = null;
    if (t.category === 'bug') {
      shot = saveFailureShot(shotsDir, c);
      const script = loadScript(opts.scriptsDir, sc.id, platform);
      const steps = (script?.steps ?? []).map(st => `${st.tool} ${st.target ? `"${st.target.text ?? st.target.label ?? st.target.rid}"` : JSON.stringify(st.args)}`);
      if (jira) jiraKey = await fileJira(jira, ticketFor(c, platform, device.id, steps), '.mobius-qa/jira-ledger.json').catch(() => null);
    }
    await notify(opts, c, t.category, last.get(sc.id), { jira: jiraKey, shot });
    last.set(sc.id, t.category);
  }
  if (values.once) break;
  await new Promise(r => setTimeout(r, interval));
}
process.exit([...last.values()].every(c => c !== 'bug') ? 0 : 1);
