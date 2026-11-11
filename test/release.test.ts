import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { GuardVerdict } from '../src/guard.ts';
import { DEFAULT_RELEASE, decision, evaluate, notesPresent, parseBadging, report, type ArtifactFacts } from '../src/release.ts';

const BADGING = `package: name='com.shop' versionCode='42' versionName='4.12.0' compileSdkVersion='35'
sdkVersion:'26'
targetSdkVersion:'35'
uses-permission: name='android.permission.INTERNET'
uses-permission: name='android.permission.CAMERA'
native-code: 'arm64-v8a' 'armeabi-v7a'`;
const prev: ArtifactFacts = { platform: 'android', id: 'com.shop', version_name: '4.11.0', version_code: '41', min_sdk: 24, target_sdk: 35,
  permissions: ['android.permission.INTERNET'], native_abis: ['arm64-v8a'], debuggable: false, signer: 'CN=Shop Release', size_bytes: 40e6 };
const marks = (items: ReturnType<typeof evaluate>) => Object.fromEntries(items.map(i => [i.check, i.mark]));

test('parse aapt2 badging', () => {
  const f = parseBadging(BADGING, 'CN=Shop Release', 46e6);
  assert.deepEqual([f.id, f.version_code, f.version_name, f.min_sdk, f.target_sdk, f.debuggable], ['com.shop', '42', '4.12.0', 26, 35, false]);
  assert.deepEqual(f.permissions, ['android.permission.CAMERA', 'android.permission.INTERNET']);
  assert.deepEqual(f.native_abis, ['arm64-v8a', 'armeabi-v7a']);
});

test('a clean release diffs against the last one and flags what changed', () => {
  const now = parseBadging(BADGING, 'CN=Shop Release', 46e6);
  const m = marks(evaluate(now, prev, null, DEFAULT_RELEASE, null));
  assert.equal(m['Build number goes up'], 'pass');
  assert.equal(m['Signed with the release key'], 'pass');
  assert.equal(m['No new sensitive permissions'], 'warn', 'CAMERA is new');
  assert.equal(m['App size growth ≤ 10%'], 'warn', '+15%');
  assert.equal(m['Minimum Android version raised'], 'warn');
  assert.equal(decision(evaluate(now, prev, null, DEFAULT_RELEASE, null)), 'GO', 'warnings inform, they do not block');
});

test('blockers: debug build, debug key, old target API, build number not raised, broken journey', () => {
  const now = { ...parseBadging(BADGING.replace("versionCode='42'", "versionCode='41'").replace("targetSdkVersion:'35'", "targetSdkVersion:'33'") + '\napplication-debuggable', 'C=US, O=Android, CN=Android Debug', 40e6) };
  const guard: GuardVerdict = { block: true, new_failures: [{ scenario: 'checkout', status: 'fail', category: 'bug', reason: 'total missing', duration_ms: 1, step_ms: [], unlabeled_controls: 0 }],
    still_failing: [], slow_steps: [], flakes: [], ui_changes: [], accessibility_regressions: [] };
  const items = evaluate(now, prev, guard, DEFAULT_RELEASE, null);
  const m = marks(items);
  for (const c of ['Build number goes up', 'Release build (not debuggable)', 'Signed with the release key', 'Target API ≥ 35 (Play requirement)', 'Critical journeys pass on a real device']) assert.equal(m[c], 'fail', c);
  assert.equal(decision(items), 'NO-GO');
  assert.match(report(now, items, DEFAULT_RELEASE), /NO-GO[\s\S]*Staged rollout plan[\s\S]*Halt rule/);
});

test('iOS: privacy manifest is required', () => {
  const ios: ArtifactFacts = { platform: 'ios', id: 'com.shop', version_name: '4.12', version_code: '100', permissions: [], debuggable: false, size_bytes: 1, plist_keys: [], has_privacy_manifest: false };
  assert.equal(decision(evaluate(ios, null, null, DEFAULT_RELEASE, null)), 'NO-GO');
});

test('release notes found in the fastlane layout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notes-'));
  mkdirSync(join(dir, 'android', 'en-US', 'changelogs'), { recursive: true });
  writeFileSync(join(dir, 'android', 'en-US', 'changelogs', '42.txt'), 'Faster checkout');
  const now = parseBadging(BADGING, 'CN=x', 1);
  assert.deepEqual(notesPresent(dir, now, ['en-US', 'hi-IN']), { 'en-US': true, 'hi-IN': false });
  rmSync(dir, { recursive: true });
});
