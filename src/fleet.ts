// Fleet: one central runner for every team's journeys. Suites come from many repos (a manifest), the app is built and
// installed once per device, and journeys are sharded across a pool of emulators and phones, each device locked so two
// runs never collide on it. Runs plain-English scenarios (through Mobius: safe, replayed, self-healing) and existing
// Maestro flows side by side, then reports by suite.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Category } from './triage.ts';

export interface Source {
  name: string;
  /** Local checkout to read journeys from. */
  dir?: string;
  /** git URL to clone when no local dir (uses your git credentials). */
  repo?: string;
  ref?: string;
  /** Folder whose sub-folders are suites. Default: "journeys". */
  root?: string;
  /** Only these suites (default: every folder under root). */
  suites?: string[];
}
export interface Manifest {
  app: { android?: string; ios?: string };
  /** Shell command run once per device before the suite: build and install the app under test. $DEVICE and $PLATFORM are set. */
  install?: string;
  sources: Source[];
  /** Retries per suite before a failure counts (default 1: triage retry). 0 = a single attempt (strict, real-backend suites). */
  retries?: Record<string, number>;
  /** Run every approval as rejected (production apps). Default true. */
  live?: boolean;
}

export interface Job { suite: string; source: string; file: string; kind: 'scenario' | 'maestro' }

export function loadManifest(path: string): Manifest {
  const m = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  if (!m.sources?.length) throw new Error(`${path}: add at least one source`);
  if (!m.app?.android && !m.app?.ios) throw new Error(`${path}: set app.android and/or app.ios`);
  const names = new Set<string>();
  for (const s of m.sources) {
    if (!s.dir && !s.repo) throw new Error(`${path}: source ${s.name} needs dir or repo`);
    if (names.has(s.name)) throw new Error(`${path}: duplicate source ${s.name}`);
    names.add(s.name);
  }
  return m;
}

/** Local dir for a source: its own dir, or a shallow clone under ~/.mobius-qa/sources. */
export function sourceDir(s: Source, cacheDir = join(homedir(), '.mobius-qa', 'sources')): string {
  if (s.dir) return resolve(s.dir.replace(/^~(?=\/)/, homedir()));
  const d = join(cacheDir, s.name);
  if (!existsSync(join(d, '.git'))) { mkdirSync(cacheDir, { recursive: true }); execFileSync('git', ['clone', '-q', '--depth', '1', s.repo!, d], { stdio: 'ignore' }); }
  // Always land on the requested ref (branch, tag or sha), fresh from origin.
  execFileSync('git', ['-C', d, 'fetch', '-q', '--depth', '1', 'origin', s.ref ?? 'HEAD'], { stdio: 'ignore' });
  execFileSync('git', ['-C', d, 'checkout', '-q', '--detach', 'FETCH_HEAD'], { stdio: 'ignore' });
  return d;
}

/**
 * Gather jobs. A suite = a folder under the source's root. *.md = plain-English scenario, *.yaml|*.yml = Maestro flow.
 * Files and folders starting with "_" are helpers (shared subflows), never run on their own. Suite names must be unique.
 */
export function assemble(m: Manifest, pick: string[] | 'all', dirOf: (s: Source) => string = sourceDir): Job[] {
  const jobs: Job[] = [];
  const owner = new Map<string, string>();
  for (const src of m.sources) {
    const root = join(dirOf(src), src.root ?? 'journeys');
    if (!existsSync(root)) continue;
    const suites = readdirSync(root).filter(d => !d.startsWith('_') && !d.startsWith('.') && statSync(join(root, d)).isDirectory())
      .filter(d => !src.suites || src.suites.includes(d)).filter(d => pick === 'all' || pick.includes(d));
    for (const suite of suites) {
      if (owner.has(suite)) throw new Error(`suite "${suite}" is defined by both ${owner.get(suite)} and ${src.name}; suite names must be unique`);
      owner.set(suite, src.name);
      for (const f of readdirSync(join(root, suite)).sort()) {
        if (f.startsWith('_')) continue;
        const kind = f.endsWith('.md') ? 'scenario' : /\.ya?ml$/.test(f) ? 'maestro' : null;
        if (kind) jobs.push({ suite, source: src.name, file: join(root, suite, f), kind });
      }
    }
  }
  if (pick !== 'all') for (const p of pick) if (!owner.has(p)) throw new Error(`no source provides suite "${p}"`);
  return jobs;
}

// ---------- device pool ----------

const lockDir = () => join(homedir(), '.mobius-qa', 'locks');
// EPERM = the process exists but belongs to another user: still alive, its lock still holds.
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** Exclusive lease on a device across processes. A lock whose owner died is stale and is taken over. */
export function acquireDevice(id: string, holder: string, dir = lockDir()): boolean {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${id.replace(/[^\w.-]/g, '_')}.lock`);
  if (existsSync(f)) {
    try {
      const l = JSON.parse(readFileSync(f, 'utf8')) as { pid: number; holder: string };
      if (alive(l.pid) && l.pid !== process.pid) return false;
    } catch { /* corrupt lock: take over */ }
  }
  writeFileSync(f, JSON.stringify({ pid: process.pid, holder, at: new Date().toISOString() }));
  return true;
}
export function releaseDevice(id: string, dir = lockDir()) { rmSync(join(dir, `${id.replace(/[^\w.-]/g, '_')}.lock`), { force: true }); }

/** Run a shell command (the build/install hook) for one device. */
export const runHook = (cmd: string, env: Record<string, string>) => new Promise<{ ok: boolean; out: string }>(res =>
  execFile('/bin/sh', ['-c', cmd], { env: { ...process.env, ...env }, maxBuffer: 64e6, timeout: 45 * 60_000 }, (e, so, se) => res({ ok: !e, out: `${so}${se}`.slice(-4000) })));

/** Maestro wants the adb serial; Mobius names emulators by AVD name. Map AVD name → emulator-NNNN when needed. */
export function maestroDeviceId(id: string): string {
  try {
    const serials = execFileSync('adb', ['devices'], { encoding: 'utf8' }).split('\n').slice(1).map(l => l.split('\t')[0]!).filter(Boolean);
    if (serials.includes(id)) return id;
    for (const s of serials.filter(x => x.startsWith('emulator-'))) {
      const name = execFileSync('adb', ['-s', s, 'emu', 'avd', 'name'], { encoding: 'utf8' }).split('\n')[0]!.trim();
      if (name === id) return s;
    }
  } catch { /* no adb: iOS UDIDs pass through */ }
  return id;
}

/** Maestro output that means the device or tooling failed, not the app: triage as infra, never page as a bug. */
export const MAESTRO_INFRA = /not connected|no devices? (found|connected)|device .* not found|unable to (launch|connect)|adb: |driver .*(timed out|failed to start|did not start up)|DriverStartupException|StatusRuntimeException: UNAVAILABLE|Command failed \(tcp:\d+\): closed|connection refused/i;

/** Run an existing Maestro flow on one device. Maestro talks to the device directly (no Mobius policy): use it on test builds. */
export const runMaestro = (file: string, device: string, appId: string) => new Promise<{ ok: boolean; out: string }>(res => {
  const bin = existsSync(join(homedir(), '.maestro/bin/maestro')) ? join(homedir(), '.maestro/bin/maestro') : 'maestro';
  execFile(bin, ['--device', maestroDeviceId(device), 'test', '-e', `MAESTRO_APP_ID=${appId}`, file], { maxBuffer: 64e6, timeout: 20 * 60_000 },
    (e, so, se) => res({ ok: !e, out: `${so}${se}`.slice(-4000) }));
});

/** Shard jobs over devices: each device pulls the next job when free (keeps fast devices busy). */
export async function shard<T, R>(jobs: T[], devices: string[], work: (job: T, device: string) => Promise<R>): Promise<R[]> {
  const queue = jobs.map((j, i) => ({ j, i }));
  const out: R[] = new Array(jobs.length);
  await Promise.all(devices.map(async d => {
    for (let next = queue.shift(); next; next = queue.shift()) out[next.i] = await work(next.j, d);
  }));
  return out;
}

// ---------- reporting ----------

export interface JobResult { job: Job; device: string; category: Category; reason: string; duration_ms: number; cost_usd: number; shot?: string | null }

export function suiteSummary(results: JobResult[]): string {
  const suites = [...new Set(results.map(r => r.job.suite))].sort();
  const icon: Record<Category, string> = { ok: '✅', ui_change: '🔄', flake: '🟡', infra: '⚙️', bug: '❌' };
  const cost = results.reduce((a, r) => a + r.cost_usd, 0);
  const bugs = results.filter(r => r.category === 'bug').length;
  const lines = suites.map(s => {
    const rs = results.filter(r => r.job.suite === s);
    const b = rs.filter(r => r.category === 'bug');
    const inf = rs.filter(r => r.category === 'infra');
    const passed = rs.length - b.length - inf.length;
    const list = [...b, ...inf].map(r => `   ${icon[r.category]} ${basename(r.job.file)}: ${r.category === 'infra' ? '(device/tooling, not the app) ' : ''}${r.reason.slice(0, 140)}`);
    return `*${s}* ${b.length ? '❌' : inf.length ? '⚙️' : '✅'} ${passed}/${rs.length}${inf.length ? ` · ${inf.length} could not run` : ''}` + (list.length ? `\n${list.join('\n')}` : '');
  });
  return [`${bugs ? '🛑' : '✅'} mobius-qa fleet · ${results.length} journeys · ${suites.length} suites · ${bugs} broken · $${cost.toFixed(2)}`, ...lines].join('\n');
}
