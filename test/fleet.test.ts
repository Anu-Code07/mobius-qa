import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireDevice, assemble, releaseDevice, shard, suiteSummary, type Manifest } from '../src/fleet.ts';

function repo(base: string, name: string, suites: Record<string, string[]>) {
  for (const [s, files] of Object.entries(suites)) {
    mkdirSync(join(base, name, 'journeys', s), { recursive: true });
    for (const f of files) writeFileSync(join(base, name, 'journeys', s, f), 'x');
  }
  return join(base, name);
}

test('assemble: suites from many repos, helpers skipped, both journey kinds', () => {
  const b = mkdtempSync(join(tmpdir(), 'fleet-'));
  const m: Manifest = { app: { android: 'com.shop' }, sources: [
    { name: 'checkout-team', dir: repo(b, 'a', { checkout: ['pay.md', 'coupon.yaml', '_login.yaml'], _common: ['warmup.yaml'] }) },
    { name: 'travel-team', dir: repo(b, 'b', { flights: ['search.md'] }) },
  ] };
  const jobs = assemble(m, 'all');
  assert.deepEqual(jobs.map(j => `${j.source}:${j.suite}/${j.file.split('/').pop()}:${j.kind}`),
    ['checkout-team:checkout/coupon.yaml:maestro', 'checkout-team:checkout/pay.md:scenario', 'travel-team:flights/search.md:scenario']);
  assert.deepEqual(assemble(m, ['flights']).map(j => j.suite), ['flights']);
  assert.throws(() => assemble(m, ['nope']), /no source provides suite "nope"/);
  rmSync(b, { recursive: true });
});

test('assemble: two repos defining the same suite is an error', () => {
  const b = mkdtempSync(join(tmpdir(), 'fleet-'));
  const m: Manifest = { app: { android: 'x' }, sources: [{ name: 'a', dir: repo(b, 'a', { cart: ['x.md'] }) }, { name: 'b', dir: repo(b, 'b', { cart: ['y.md'] }) }] };
  assert.throws(() => assemble(m, 'all'), /defined by both a and b/);
  rmSync(b, { recursive: true });
});

test('device locks: exclusive, stale locks taken over, released', () => {
  const d = mkdtempSync(join(tmpdir(), 'locks-'));
  assert.equal(acquireDevice('emu-1', 'run A', d), true);
  writeFileSync(join(d, 'emu-2.lock'), JSON.stringify({ pid: 1, holder: 'launchd' })); // pid 1 is alive and not us: busy
  assert.equal(acquireDevice('emu-2', 'run B', d), false);
  writeFileSync(join(d, 'emu-3.lock'), JSON.stringify({ pid: 99999999, holder: 'dead run' }));
  assert.equal(acquireDevice('emu-3', 'run C', d), true, 'dead owner = stale lock');
  releaseDevice('emu-1', d);
  assert.equal(acquireDevice('emu-1', 'run D', d), true);
  rmSync(d, { recursive: true });
});

test('shard: every job runs once, spread over devices, order of results kept', async () => {
  const seen: string[] = [];
  const out = await shard([1, 2, 3, 4, 5], ['a', 'b'], async (j, d) => { seen.push(d); await new Promise(r => setTimeout(r, j % 2 ? 5 : 1)); return j * 10; });
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
  assert.ok(seen.includes('a') && seen.includes('b'));
});

test('summary groups by suite and lists only broken journeys', () => {
  const job = (suite: string, f: string) => ({ suite, source: 's', file: `/x/${f}`, kind: 'scenario' as const });
  const t = suiteSummary([
    { job: job('checkout', 'pay.md'), device: 'a', category: 'bug', reason: 'total missing', duration_ms: 1, cost_usd: 0 },
    { job: job('checkout', 'coupon.md'), device: 'b', category: 'flake', reason: 'passed on retry', duration_ms: 1, cost_usd: 0 },
    { job: job('flights', 'search.md'), device: 'a', category: 'ok', reason: 'ok', duration_ms: 1, cost_usd: 0.16 },
  ]);
  assert.match(t, /🛑 .* 3 journeys · 2 suites · 1 broken · \$0\.16/);
  assert.match(t, /\*checkout\* ❌ 1\/2\n.*pay\.md: total missing/);
  assert.match(t, /\*flights\* ✅ 1\/1/);
  assert.doesNotMatch(t, /coupon/, 'flakes do not get listed as broken');
});

test('maestro device trouble is infra, not an app bug', async () => {
  const { MAESTRO_INFRA } = await import('../src/fleet.ts');
  assert.ok(MAESTRO_INFRA.test('Device Lite_Pool_1080x1920 was requested, but it is not connected.'));
  assert.ok(MAESTRO_INFRA.test('Maestro Android driver did not start up in time'));
  assert.ok(MAESTRO_INFRA.test('io.grpc.StatusRuntimeException: UNAVAILABLE'));
  assert.ok(!MAESTRO_INFRA.test('Assertion is false: "Services" is visible'));
});
