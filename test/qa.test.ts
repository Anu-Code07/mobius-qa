import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyVerdict } from '../src/evidence.ts';
import { compile, findElement, replay, type Call } from '../src/replay.ts';
import type { RunResult, TraceStep, Verdict } from '../src/runner.ts';
import { parseScenario } from '../src/scenario.ts';

const obs = (id: string, elements: object[]) => JSON.stringify({ observation_id: id, elements });
const step = (tool: string, input: object, output: string, isError = false): TraceStep => ({ t: 0, tool, input, output, isError });
const FOOD = [
  step('open_app', { device_id: 'd', app_id: 'food' }, JSON.stringify({ ok: true })),
  step('observe', { device_id: 'd' }, obs('o1', [{ id: 'o1:e1', role: 'button', text: 'View cart' }])),
  step('tap', { device_id: 'd', element_id: 'o1:e9' }, JSON.stringify({ ok: false, error: { code: 'ELEMENT_NOT_FOUND' } }), true), // agent detour
  step('tap', { device_id: 'd', element_id: 'o1:e1' }, JSON.stringify({ ok: true })),
  step('observe', { device_id: 'd' }, obs('o2', [{ id: 'o2:e1', role: 'text', text: 'Total ₹349' }, { id: 'o2:e2', role: 'button', text: 'Place order' }])),
  step('tap', { device_id: 'd', element_id: 'o2:e2' }, JSON.stringify({ ok: false, status: 'blocked', error: { code: 'APPROVAL_REJECTED' } }), true),
];
const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  status: 'pass', summary: 'ok', bugs: [],
  expectations: [
    { text: 'Total is ₹349', met: true, evidence: [{ ref: 'o2', quote: '₹349' }] },
    { text: 'Place order stopped by approval', met: true, evidence: [{ ref: 'step:6', quote: 'APPROVAL_REJECTED' }] },
  ], ...over,
});

test('evidence: verified claims pass', () => {
  const { verdict: v, checks } = verifyVerdict(verdict(), FOOD);
  assert.equal(v.status, 'pass');
  assert.ok(checks.every(c => c.ok));
});

test('evidence: an invented quote or id turns a claimed pass into a fail', () => {
  const lie = verdict({ expectations: [{ text: 'Total is ₹299', met: true, evidence: [{ ref: 'o2', quote: '₹299' }] }] });
  assert.equal(verifyVerdict(lie, FOOD).verdict.status, 'fail');
  const ghost = verdict({ expectations: [{ text: 'x', met: true, evidence: [{ ref: 'o99', quote: 'Total' }] }] });
  assert.match(verifyVerdict(ghost, FOOD).verdict.summary, /o99 not found/);
  const bare = verdict({ expectations: [{ text: 'x', met: true, evidence: [] }] });
  assert.equal(verifyVerdict(bare, FOOD).verdict.status, 'fail');
});

const run = (): RunResult => ({
  scenario: parseScenario('---\nid: food\nandroid: food\n---\n# Food\nOrder.\n## Expect\n- total\n'),
  device: { id: 'd', platform: 'android' }, verdict: verdict(), trace: FOOD, costUsd: 0.22, turns: 9, durationMs: 1,
});

test('compile: keeps the journey, drops detours, records the safety stop', () => {
  const s = compile(run());
  assert.deepEqual(s.steps.map(x => x.tool), ['open_app', 'tap', 'tap']);
  assert.deepEqual(s.steps[1]!.target, { role: 'button', text: 'View cart', label: null, rid: null });
  assert.equal(s.steps[2]!.expect_error, 'APPROVAL_REJECTED');
  assert.deepEqual(s.checks.flatMap(c => c.quotes), ['₹349', 'APPROVAL_REJECTED']);
});

/** A fake device behind Mobius: screens by step, configurable approval behaviour. */
function fakeDevice(opts: { cartLabel?: string; approvalAsks?: boolean; total?: string } = {}): Call {
  let screen = 'home';
  return async (tool, args) => {
    const j = (o: object) => ({ text: JSON.stringify(o), json: o });
    if (tool === 'observe') {
      return j(screen === 'home'
        ? { observation_id: 'o5', elements: [{ id: 'o5:e3', role: 'button', text: opts.cartLabel ?? 'View cart' }] }
        : { observation_id: 'o6', elements: [{ id: 'o6:e1', role: 'text', text: `Total ${opts.total ?? '₹349'}` }, { id: 'o6:e4', role: 'button', text: 'Place order' }] });
    }
    if (tool === 'tap' && args.element_id === 'o5:e3') { screen = 'cart'; return j({ ok: true }); }
    if (tool === 'tap' && args.element_id === 'o6:e4') {
      return opts.approvalAsks === false ? j({ ok: true, message: 'Tapped' }) : j({ ok: false, error: { code: 'APPROVAL_REJECTED' }, message: 'User rejected' });
    }
    return j({ ok: true });
  };
}

test('replay: same journey re-verified with zero model calls', async () => {
  const r = await replay(compile(run()), fakeDevice(), 0);
  assert.equal(r.status, 'pass', r.reason);
});

test('replay: renamed button is drift (agent heals), not a false alarm', async () => {
  const r = await replay(compile(run()), fakeDevice({ cartLabel: 'Go to bag' }), 0);
  assert.equal(r.status, 'drift');
});

test('replay: a wrong total is a real failure', async () => {
  const r = await replay(compile(run()), fakeDevice({ total: '₹449' }), 0);
  assert.equal(r.status, 'fail');
  assert.deepEqual(r.missing_quotes, ['₹349']);
});

test('replay: if the approval stop disappears, that is a failure (the journey would now pay)', async () => {
  const r = await replay(compile(run()), fakeDevice({ approvalAsks: false }), 0);
  assert.equal(r.status, 'fail');
  assert.match(r.reason, /expected APPROVAL_REJECTED, got success/);
});

test('element matching survives re-renders but refuses ambiguity', () => {
  const sel = { role: 'button', text: 'Add', label: null, rid: null };
  assert.equal(findElement([{ id: 'a', role: 'button', text: 'Add' }], sel).id, 'a');
  assert.equal(findElement([{ id: 'a', role: 'button', text: 'Add', label: 'x' }, { id: 'b', role: 'button', text: 'Add', label: 'y' }], sel), null);
});

test('evidence: quotes match through JSON escapes and across adjacent elements (real-run regression)', async () => {
  const { quoteIn } = await import('../src/evidence.ts');
  const out = JSON.stringify({ message: 'User rejected: single tap on button "Place order"', elements: [{ text: 'Total\n₹349' }] });
  assert.ok(quoteIn(out, 'User rejected: single tap on button "Place order"'));
  assert.ok(quoteIn(out, 'Total\n₹349'));
  assert.ok(quoteIn(JSON.stringify({ elements: [{ text: 'Total' }, { text: '₹349' }] }), 'Total ₹349'));
  assert.ok(!quoteIn(out, 'Total ₹299'), 'a wrong amount still fails');
});
