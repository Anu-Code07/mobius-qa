// Release manager: one go/no-go for a mobile release. Inspects the build itself, compares it with the last release,
// folds in the release guard (real journeys on a device), and lists what still needs a human, then a staged-rollout
// plan whose halt rule is mobius-qa monitoring. Automated checks never pretend to cover the manual ones.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GuardVerdict } from './guard.ts';

/** What we can read out of the binary. */
export interface ArtifactFacts {
  platform: 'android' | 'ios';
  id: string;
  version_name: string;
  version_code: string;
  min_sdk?: number;
  target_sdk?: number;
  permissions: string[];
  native_abis?: string[];
  debuggable: boolean;
  /** Signing identity (Android cert DN); "Android Debug" means a debug key. */
  signer?: string | null;
  size_bytes: number;
  /** iOS: Info.plist keys, for privacy strings and export compliance. */
  plist_keys?: string[];
  has_privacy_manifest?: boolean;
}

export interface ReleaseConfig {
  /** Google Play's current minimum target API for updates; raise it when Play does. */
  min_target_sdk: number;
  max_size_growth_pct: number;
  /** Locales that must have release notes (fastlane layout), e.g. ["en-US", "hi-IN"]. */
  notes_locales: string[];
  rollout: number[];
}
export const DEFAULT_RELEASE: ReleaseConfig = { min_target_sdk: 35, max_size_growth_pct: 10, notes_locales: ['en-US'], rollout: [1, 5, 20, 50, 100] };

export type Mark = 'pass' | 'warn' | 'fail' | 'manual';
export interface Item { area: string; check: string; mark: Mark; detail: string }

// ---------- reading the artifact ----------

const sdkTool = (name: string): string | null => {
  const root = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'Library/Android/sdk');
  const bt = join(root, 'build-tools');
  if (!existsSync(bt)) return null;
  const v = readdirSync(bt).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
  const p = v ? join(bt, v, name) : '';
  return v && existsSync(p) ? p : null;
};

/** Parse `aapt2 dump badging` (+ `apksigner verify --print-certs`) output. Exported for tests. */
export function parseBadging(badging: string, signer: string | null, size: number): ArtifactFacts {
  const pkg = /package: name='([^']+)' versionCode='([^']*)' versionName='([^']*)'/.exec(badging);
  if (!pkg) throw new Error('not an APK (no package line in aapt2 output)');
  const num = (re: RegExp) => { const m = re.exec(badging); return m ? Number(m[1]) : undefined; };
  const min = num(/(?:^|\n)(?:min)?[sS]dkVersion:'(\d+)'/);
  const target = num(/targetSdkVersion:'(\d+)'/);
  return {
    platform: 'android', id: pkg[1]!, version_code: pkg[2]!, version_name: pkg[3]!,
    ...(min !== undefined ? { min_sdk: min } : {}), ...(target !== undefined ? { target_sdk: target } : {}),
    permissions: [...badging.matchAll(/uses-permission: name='([^']+)'/g)].map(m => m[1]!).sort(),
    native_abis: (/native-code: (.+)/.exec(badging)?.[1] ?? '').match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) ?? [],
    debuggable: /\napplication-debuggable/.test(`\n${badging}`),
    signer, size_bytes: size,
  };
}

export function readArtifact(path: string): ArtifactFacts {
  const size = statSync(path).size;
  if (path.endsWith('.apk')) {
    const aapt = sdkTool('aapt2');
    if (!aapt) throw new Error('aapt2 not found: install Android build-tools or set ANDROID_HOME');
    const badging = execFileSync(aapt, ['dump', 'badging', path], { encoding: 'utf8', maxBuffer: 32e6 });
    const signerTool = sdkTool('apksigner');
    let signer: string | null = null;
    if (signerTool) {
      try { signer = /certificate DN: (.+)/.exec(execFileSync(signerTool, ['verify', '--print-certs', path], { encoding: 'utf8' }))?.[1] ?? null; }
      catch { signer = null; } // unsigned or invalid signature
    }
    return parseBadging(badging, signer, size);
  }
  if (path.endsWith('.ipa')) {
    const dir = join(tmpdir(), `mqa-ipa-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    // unzip exits non-zero when one pattern (e.g. a missing privacy manifest) matches nothing; the rest still extracts.
    try { execFileSync('unzip', ['-o', '-q', path, 'Payload/*.app/Info.plist', 'Payload/*.app/PrivacyInfo.xcprivacy', '-d', dir], { stdio: 'ignore' }); } catch { /* checked below */ }
    const app = readdirSync(join(dir, 'Payload')).find(f => f.endsWith('.app'))!;
    const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', join(dir, 'Payload', app, 'Info.plist')], { encoding: 'utf8' }));
    return {
      platform: 'ios', id: plist.CFBundleIdentifier, version_name: plist.CFBundleShortVersionString, version_code: plist.CFBundleVersion,
      permissions: Object.keys(plist).filter(k => /^NS\w+UsageDescription$/.test(k)).sort(), debuggable: false, size_bytes: size,
      plist_keys: Object.keys(plist), has_privacy_manifest: existsSync(join(dir, 'Payload', app, 'PrivacyInfo.xcprivacy')),
    };
  }
  throw new Error('artifact must be an .apk or .ipa (for an .aab, build a universal APK with bundletool first)');
}

// ---------- checks ----------

const DANGEROUS = /permission\.(CAMERA|RECORD_AUDIO|READ_CONTACTS|WRITE_CONTACTS|ACCESS_(FINE|COARSE|BACKGROUND)_LOCATION|READ_SMS|SEND_SMS|RECEIVE_SMS|READ_CALL_LOG|CALL_PHONE|READ_PHONE_STATE|BODY_SENSORS|READ_MEDIA_\w+|READ_EXTERNAL_STORAGE|POST_NOTIFICATIONS|SYSTEM_ALERT_WINDOW|REQUEST_INSTALL_PACKAGES|QUERY_ALL_PACKAGES|MANAGE_EXTERNAL_STORAGE)$/;
const versionGreater = (a: string, b: string) => {
  const pa = a.split(/[.\-]/).map(Number), pb = b.split(/[.\-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = pa[i] ?? 0, y = pb[i] ?? 0; if (x !== y) return x > y; }
  return false;
};

/** Every automated check, plus the manual ones a human must tick. */
export function evaluate(now: ArtifactFacts, prev: ArtifactFacts | null, guard: GuardVerdict | null, cfg: ReleaseConfig, notes: Record<string, boolean> | null): Item[] {
  const it: Item[] = [];
  const add = (area: string, check: string, mark: Mark, detail: string) => it.push({ area, check, mark, detail });

  // Build integrity
  if (prev) {
    add('Build', 'Same app id as the last release', now.id === prev.id ? 'pass' : 'fail', `${prev.id} → ${now.id}`);
    add('Build', 'Build number goes up', versionGreater(now.version_code, prev.version_code) ? 'pass' : 'fail', `${prev.version_code} → ${now.version_code}`);
    add('Build', 'Version name changed', now.version_name !== prev.version_name ? 'pass' : 'warn', `${prev.version_name} → ${now.version_name}`);
  } else add('Build', 'Version', 'pass', `${now.version_name} (${now.version_code}); no previous release on record to compare`);
  add('Build', 'Release build (not debuggable)', now.debuggable ? 'fail' : 'pass', now.debuggable ? 'debuggable: true. Stores reject it and it exposes the app' : 'not debuggable');
  if (now.platform === 'android') {
    const debugKey = !now.signer || /CN=Android Debug/.test(now.signer);
    add('Build', 'Signed with the release key', debugKey ? 'fail' : 'pass', now.signer ? now.signer : 'unsigned or invalid signature');
    if (now.target_sdk !== undefined) add('Store', `Target API ≥ ${cfg.min_target_sdk} (Play requirement)`, now.target_sdk >= cfg.min_target_sdk ? 'pass' : 'fail', `targetSdk ${now.target_sdk}`);
    if (prev?.min_sdk !== undefined && now.min_sdk !== undefined && now.min_sdk > prev.min_sdk) add('Users', 'Minimum Android version raised', 'warn', `minSdk ${prev.min_sdk} → ${now.min_sdk}: users on older phones stop getting updates`);
    if (now.native_abis?.length) {
      const has64 = now.native_abis.some(a => a.includes('64'));
      add('Store', '64-bit native code', has64 ? 'pass' : 'fail', now.native_abis.join(', '));
    }
  } else {
    const keys = now.plist_keys ?? [];
    add('Store', 'Privacy manifest (PrivacyInfo.xcprivacy)', now.has_privacy_manifest ? 'pass' : 'fail', now.has_privacy_manifest ? 'present' : 'missing: App Store rejects apps using required-reason APIs without it');
    add('Store', 'Export compliance declared (ITSAppUsesNonExemptEncryption)', keys.includes('ITSAppUsesNonExemptEncryption') ? 'pass' : 'warn', keys.includes('ITSAppUsesNonExemptEncryption') ? 'set' : 'not set: App Store Connect will ask on every upload');
  }
  // Permissions and size
  if (prev) {
    const added = now.permissions.filter(p => !prev.permissions.includes(p));
    const risky = added.filter(p => DANGEROUS.test(p) || /^NS\w+UsageDescription$/.test(p));
    add('Privacy', 'No new sensitive permissions', risky.length ? 'warn' : 'pass', risky.length ? `new: ${risky.join(', ')}. Update the Data safety form / privacy labels and review` : added.length ? `new (normal): ${added.join(', ')}` : 'unchanged');
    const growth = ((now.size_bytes - prev.size_bytes) / prev.size_bytes) * 100;
    add('Users', `App size growth ≤ ${cfg.max_size_growth_pct}%`, growth > cfg.max_size_growth_pct ? 'warn' : 'pass', `${(prev.size_bytes / 1e6).toFixed(1)} MB → ${(now.size_bytes / 1e6).toFixed(1)} MB (${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%)`);
  }
  // Real journeys (release guard)
  if (guard) {
    add('Journeys', 'Critical journeys pass on a real device', guard.new_failures.length ? 'fail' : 'pass', guard.new_failures.length ? guard.new_failures.map(j => `${j.scenario}: ${j.reason}`).join('; ') : 'no new failures vs the last good build');
    add('Journeys', 'No steps got much slower', guard.slow_steps.length ? 'fail' : 'pass', guard.slow_steps.length ? guard.slow_steps.map(s => `${s.scenario} "${s.target}" ${(s.before_ms / 1e3).toFixed(1)}s→${(s.now_ms / 1e3).toFixed(1)}s`).join('; ') : 'within limits');
    if (guard.still_failing.length) add('Journeys', 'Known-broken journeys', 'warn', guard.still_failing.map(j => j.scenario).join(', ') + ' (already broken in the last release)');
    add('Accessibility', 'No new unlabeled controls', guard.accessibility_regressions.length ? 'warn' : 'pass', guard.accessibility_regressions.map(a => `${a.scenario}: ${a.before}→${a.now}`).join('; ') || 'unchanged');
  } else add('Journeys', 'Critical journeys on a real device', 'manual', 'run with --guard <scenarios> --device <id> to check automatically');
  // Store listing
  if (notes) for (const [loc, ok] of Object.entries(notes)) add('Store', `Release notes (${loc})`, ok ? 'pass' : 'fail', ok ? 'present' : 'missing');
  else add('Store', 'Release notes for every store locale', 'manual', 'pass --notes <fastlane metadata dir> to check automatically');
  // What only a human can confirm
  for (const [area, check, detail] of [
    ['Quality', 'Crash-free sessions on the beta / previous rollout ≥ target', 'Play Vitals / Crashlytics / Xcode Organizer'],
    ['Quality', 'Unit and UI test suites green on this commit', 'CI'],
    ['Backend', 'APIs this build calls are deployed, backward compatible with older app versions', 'backend owners'],
    ['Backend', 'Force-update / minimum-version config correct', 'remote config'],
    ['Flags', 'Feature-flag defaults for this release reviewed; risky features dark-launched', 'flag dashboard'],
    ['Store', 'Store listing, screenshots, Data safety form / privacy labels up to date', 'Play Console / App Store Connect'],
    ['Compliance', 'Legal / payments / regional compliance sign-off where needed', 'owners'],
    ['Rollback', 'Previous build available to halt and roll back; server-side kill switches ready', 'release owner'],
    ['People', 'On-call assigned for the rollout window; support briefed on what changed', 'release owner'],
  ] as const) add(area, check, 'manual', detail);
  return it;
}

export function decision(items: Item[]): 'GO' | 'NO-GO' { return items.some(i => i.mark === 'fail') ? 'NO-GO' : 'GO'; }

const ICON: Record<Mark, string> = { pass: '✅', warn: '⚠️', fail: '❌', manual: '☐' };

export function report(now: ArtifactFacts, items: Item[], cfg: ReleaseConfig): string {
  const d = decision(items);
  const by = (m: Mark) => items.filter(i => i.mark === m).length;
  const rows = items.map(i => `| ${ICON[i.mark]} | ${i.area} | ${i.check} | ${i.detail.replace(/\|/g, '/')} |`).join('\n');
  const stages = cfg.rollout.map((p, n) => `${n + 1}. **${p}%**${n === 0 ? ' (or internal track first)' : ''}: ` +
    (p < 100 ? 'hold until mobius-qa monitor shows no new bugs and the crash-free rate holds, then widen' : 'full rollout; mobius-qa keeps monitoring every critical journey')).join('\n');
  return [
    `# Release ${now.version_name} (${now.version_code}) · ${now.platform} · ${now.id}`,
    `## ${d === 'GO' ? '🟢 GO' : '🔴 NO-GO'} · ${by('pass')} passed · ${by('warn')} warnings · ${by('fail')} blocking · ${by('manual')} to confirm by hand`,
    '| | Area | Check | Detail |\n|---|---|---|---|\n' + rows,
    `## Staged rollout plan\n${stages}\n\n**Halt rule:** pause the rollout if \`mobius-qa monitor\` confirms a bug on any critical journey (it retries before alerting, so flakes don't halt it), or crash-free sessions drop below target. Roll back to ${'the previous build'} if a fix needs more than one rollout window.`,
  ].join('\n\n');
}

/** fastlane layout: metadata/android/<locale>/changelogs/<versionCode>.txt · metadata/<locale>/release_notes.txt (iOS). */
export function notesPresent(dir: string, now: ArtifactFacts, locales: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const l of locales) {
    const candidates = now.platform === 'android'
      ? [join(dir, 'android', l, 'changelogs', `${now.version_code}.txt`), join(dir, l, 'changelogs', `${now.version_code}.txt`), join(dir, 'android', l, 'changelogs', 'default.txt')]
      : [join(dir, l, 'release_notes.txt'), join(dir, 'ios', l, 'release_notes.txt')];
    out[l] = candidates.some(f => existsSync(f) && readFileSync(f, 'utf8').trim().length > 0);
  }
  return out;
}

export function saveRelease(dir: string, f: ArtifactFacts) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${f.platform}-${f.id}.json`), JSON.stringify(f, null, 2)); }
export function lastRelease(dir: string, platform: string, id: string): ArtifactFacts | null {
  const p = join(dir, `${platform}-${id}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
