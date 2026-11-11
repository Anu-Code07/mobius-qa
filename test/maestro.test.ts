import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { convertFlow } from '../src/maestro.ts';
import { parseScenario } from '../src/scenario.ts';
import { replay, type Call } from '../src/replay.ts';

function flows() {
  const d = mkdtempSync(join(tmpdir(), 'maestro-'));
  mkdirSync(join(d, '_common'));
  writeFileSync(join(d, '_common', 'login.yaml'), `appId: \${APP}\n---\n- tapOn: "Login"\n- inputText: "riya@example.com"\n`);
  writeFileSync(join(d, 'checkout.yaml'), `appId: \${APP}
env:
  APP: com.shop
---
- launchApp
- runFlow: _common/login.yaml
- tapOn:
    id: "cart_button"
- assertVisible: "Total ₹349"
- scrollUntilVisible:
    element:
      text: "Place order"
    direction: DOWN
- tapOn: "Place order"
- tapOn:
    point: "50%,90%"
- inputRandomEmail
- waitForAnimationToEnd
`);
  return d;
}

test('converts a Maestro flow: subflows inlined, selectors kept, checks from assertions, gaps reported', () => {
  const d = flows();
  const c = convertFlow(join(d, 'checkout.yaml'), { platform: 'android' });
  assert.equal(c.script.app, 'com.shop');
  assert.deepEqual(c.script.steps.map(s => s.tool), ['open_app', 'tap', 'type', 'tap', 'wait_for', 'scroll', 'scroll', 'scroll', 'wait_for', 'tap']);
  assert.deepEqual(c.script.steps[1]!.target, { role: '*', text: 'Login', label: null, rid: null });
  assert.deepEqual(c.script.steps[3]!.target, { role: '*', text: null, label: null, rid: 'cart_button' });
  assert.deepEqual(c.script.checks.flatMap(x => x.quotes), ['Total ₹349']);
  assert.equal(c.unsupported.length, 2, 'point tap and random input reported, not silently dropped');
  const sc = parseScenario(c.scenario, 'checkout.md');
  assert.equal(sc.approvals, 'rejected', 'imported journeys are safe by default');
  assert.match(sc.goal, /Tap "Place order"/);
  rmSync(d, { recursive: true });
});

test('an imported flow replays through Mobius, and its Pay tap hits the safety gate', async () => {
  const d = flows();
  const { script } = convertFlow(join(d, 'checkout.yaml'), { platform: 'android' });
  script.steps = script.steps.filter(s => !(s.tool === 'scroll' || (s.tool === 'wait_for' && s.args.text_visible === 'Place order')));
  let screen = 'home';
  const device: Call = async (tool, args) => {
    const j = (o: object) => ({ text: JSON.stringify(o), json: o });
    if (tool === 'observe') return j({ observation_id: 'o1', foreground_app: 'com.shop', elements: screen === 'home'
      ? [{ id: 'o1:e1', role: 'button', text: 'Login' }, { id: 'o1:e2', role: 'button', label: 'Cart', rid: 'com.shop:id/cart_button' }]
      : [{ id: 'o1:e3', role: 'text', text: 'Total ₹349' }, { id: 'o1:e4', role: 'button', text: 'Place order' }] });
    if (tool === 'tap' && args.element_id === 'o1:e2') { screen = 'cart'; return j({ ok: true }); }
    if (tool === 'tap' && args.element_id === 'o1:e4') return j({ ok: false, error: { code: 'APPROVAL_REJECTED' } }); // Mobius stops it
    if (tool === 'wait_for') return j({ ok: true, text: 'Total ₹349' });
    return j({ ok: true });
  };
  const r = await replay(script, device, 0);
  // The Maestro flow expected Place order to succeed; through Mobius it is stopped, so the replay reports it instead of paying.
  assert.equal(r.status, 'fail');
  assert.match(r.reason, /APPROVAL_REJECTED/);
  rmSync(d, { recursive: true });
});
