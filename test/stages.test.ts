// Stages 3–5: release guard, triage + Jira, discovery output, reliability signals.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scenarioMarkdown } from '../src/discover.ts';
import { compare, lastGoodBuild, saveBuild, summary, type BuildRecord, type JourneyRecord } from '../src/guard.ts';
import type { CheckOutcome } from '../src/monitor.ts';
import { replay, type Call, type ReplayScript } from '../src/replay.ts';
import { parseScenario } from '../src/scenario.ts';
import { categorize, fileJira, ticketFor, triage } from '../src/triage.ts';

const out = (status: CheckOutcome['status'], reason = 'r'): CheckOutcome => ({ scenario: 'checkout', status, mode: 'replay', reason, cost_usd: 0, duration_ms: 1 });

test('triage: bug vs flake vs UI change vs infra', async () => {
  assert.equal(categorize(out('pass')), 'ok');
  assert.equal(categorize(out('healed')), 'ui_change');
  assert.equal(categorize(out('fail'), out('fail')), 'bug');
  assert.equal(categorize(out('fail'), out('pass')), 'flake');
  assert.equal(categorize(out('error'), out('error')), 'infra');
  let n = 0;
  const flaky = await triage(async () => (n++ === 0 ? out('fail') : out('pass')));
  assert.deepEqual([flaky.category, flaky.retried], ['flake', true]);
  const steady = await triage(async () => out('pass'));
  assert.deepEqual([steady.category, steady.retried], ['ok', false], 'no retry when it passes');
});

const j = (scenario: string, category: JourneyRecord['category'], ms = 1000, unlabeled = 0): JourneyRecord =>
  ({ scenario, status: category === 'bug' ? 'fail' : 'pass', category, reason: category, duration_ms: ms, step_ms: [{ step: 2, tool: 'tap', target: 'Apply coupon', ms }], unlabeled_controls: unlabeled });
const build = (b: string, journeys: JourneyRecord[]): BuildRecord => ({ build: b, platform: 'android', at: '', journeys });

test('release guard: a new failure blocks; an already-broken journey does not block twice', () => {
  const base = build('4.11', [j('coupon', 'ok'), j('login', 'bug')]);
  const v = compare(build('4.12', [j('coupon', 'bug'), j('login', 'bug')]), base);
  assert.equal(v.block, true);
  assert.deepEqual(v.new_failures.map(x => x.scenario), ['coupon']);
  assert.deepEqual(v.still_failing.map(x => x.scenario), ['login']);
  assert.match(summary(build('4.12', []), base, v), /BLOCK[\s\S]*coupon/);
});

test('release guard: big slowdowns block, flakes and UI changes only inform', () => {
  const base = build('4.11', [j('coupon', 'ok', 1200, 0), j('search', 'ok')]);
  const v = compare(build('4.12', [j('coupon', 'ok', 4200, 3), j('search', 'flake')]), base);
  assert.equal(v.block, true);
  assert.deepEqual(v.slow_steps.map(s => [s.target, s.before_ms, s.now_ms]), [['Apply coupon', 1200, 4200]]);
  assert.deepEqual(v.accessibility_regressions, [{ scenario: 'coupon', before: 0, now: 3 }]);
  const calm = compare(build('4.13', [j('coupon', 'ui_change'), j('search', 'flake')]), base);
  assert.equal(calm.block, false);
});

test('release guard: baseline is the last good build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-builds-'));
  saveBuild(dir, build('4.10', [j('a', 'ok')]));
  saveBuild(dir, build('4.11', [j('a', 'bug')]));
  assert.equal(lastGoodBuild(dir, 'android', '4.12')?.build, '4.10', 'skips the broken 4.11');
  rmSync(dir, { recursive: true });
});

test('jira: one ticket per distinct failure, with repro steps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-jira-'));
  const sent: any[] = [];
  const fake = (async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ key: 'APP-42' }), { status: 201 }); }) as typeof fetch;
  const t = ticketFor(out('fail', 'expected evidence not seen: "₹349"'), 'android', 'emu', ['open_app', 'tap "View cart"']);
  const cfg = { url: 'https://x.atlassian.net', email: 'e', token: 't', project: 'APP' };
  assert.equal(await fileJira(cfg, t, join(dir, 'l.json'), fake), 'APP-42');
  assert.equal(await fileJira(cfg, t, join(dir, 'l.json'), fake), 'APP-42');
  assert.equal(sent.length, 1, 'deduped');
  assert.match(JSON.stringify(sent[0]), /Steps to reproduce[\s\S]*View cart/);
  rmSync(dir, { recursive: true });
});

test('discover: proposals become runnable, safe-by-default scenarios', () => {
  const md = scenarioMarkdown({ id: 'checkout-up-to-pay', title: 'Checkout up to Pay', why: 'Revenue', goal: 'Add an item and open the cart.', expect: ['Cart shows a total'], priority: 'critical' }, 'android', 'com.shop');
  const sc = parseScenario(md, 'checkout-up-to-pay.md');
  assert.equal(sc.approvals, 'rejected');
  assert.equal(sc.app.android, 'com.shop');
  assert.deepEqual(sc.expect, ['Cart shows a total']);
});

test('reliability: per-step timing, unlabeled controls, and a crash mid-journey fails the run', async () => {
  const script: ReplayScript = { scenario: 's', platform: 'android', app: 'com.shop', compiled_at: '', checks: [{ expectation: 'x', quotes: ['Cart'] }],
    steps: [{ tool: 'tap', args: {}, target: { role: 'button', text: 'Cart', label: null, rid: null } }] };
  const device = (crash: boolean): Call => {
    let tapped = false;
    return async (tool) => {
      const o = tool === 'observe'
        ? { observation_id: tapped ? 'o2' : 'o1', foreground_app: crash && tapped ? 'com.android.launcher' : 'com.shop', tree_quality: 'good',
            elements: [{ id: 'o1:e1', role: 'button', text: 'Cart' }, { id: 'o1:e2', role: 'button' }] }
        : (tapped = true, { ok: true });
      return { text: JSON.stringify(o), json: o };
    };
  };
  const ok = await replay(script, device(false), 0);
  assert.equal(ok.status, 'pass', ok.reason);
  assert.equal(ok.reliability.step_ms.length, 1);
  assert.equal(ok.reliability.accessibility.unlabeled_controls, 2, 'one unlabeled button on each of 2 screens');
  const crashed = await replay(script, device(true), 0);
  assert.equal(crashed.status, 'fail');
  assert.match(crashed.reason, /left the foreground/);
});
