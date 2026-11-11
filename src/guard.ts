// Stage 3: release guard. Run every journey against a build, compare with the last good build, and fail the pipeline
// (pause the rollout) when a journey that passed before now fails, or a step got much slower.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Category } from './triage.ts';

export interface JourneyRecord {
  scenario: string;
  status: string;
  category: Category;
  reason: string;
  duration_ms: number;
  step_ms: { step: number; tool: string; target: string; ms: number }[];
  unlabeled_controls: number;
}
export interface BuildRecord { build: string; platform: string; at: string; journeys: JourneyRecord[] }

export interface GuardThresholds {
  /** A step must be this much slower (ratio) AND this many ms slower to count as a regression. */
  slower_ratio: number;
  slower_ms: number;
}
export const DEFAULT_THRESHOLDS: GuardThresholds = { slower_ratio: 1.5, slower_ms: 1000 };

export interface GuardVerdict {
  block: boolean;
  new_failures: JourneyRecord[];
  still_failing: JourneyRecord[];
  slow_steps: { scenario: string; step: number; target: string; before_ms: number; now_ms: number }[];
  flakes: JourneyRecord[];
  ui_changes: JourneyRecord[];
  accessibility_regressions: { scenario: string; before: number; now: number }[];
}

const failed = (j: JourneyRecord) => j.category === 'bug' || j.category === 'infra';

export function compare(now: BuildRecord, base: BuildRecord | null, t: GuardThresholds = DEFAULT_THRESHOLDS): GuardVerdict {
  const prev = new Map((base?.journeys ?? []).map(j => [j.scenario, j]));
  const v: GuardVerdict = { block: false, new_failures: [], still_failing: [], slow_steps: [], flakes: [], ui_changes: [], accessibility_regressions: [] };
  for (const j of now.journeys) {
    const p = prev.get(j.scenario);
    if (j.category === 'bug') (p && failed(p) ? v.still_failing : v.new_failures).push(j);
    if (j.category === 'flake') v.flakes.push(j);
    if (j.category === 'ui_change') v.ui_changes.push(j);
    if (p && !failed(p) && !failed(j)) {
      for (const s of j.step_ms) {
        const b = p.step_ms.find(x => x.step === s.step && x.target === s.target);
        if (b && s.ms >= b.ms * t.slower_ratio && s.ms - b.ms >= t.slower_ms) {
          v.slow_steps.push({ scenario: j.scenario, step: s.step, target: s.target, before_ms: b.ms, now_ms: s.ms });
        }
      }
      if (j.unlabeled_controls > p.unlabeled_controls) v.accessibility_regressions.push({ scenario: j.scenario, before: p.unlabeled_controls, now: j.unlabeled_controls });
    }
  }
  // Infra trouble never blocks a release on its own (it isn't the build's fault); bugs and big slowdowns do.
  v.block = v.new_failures.length > 0 || v.slow_steps.length > 0;
  return v;
}

/** Markdown for a PR comment / CI summary. */
export function summary(now: BuildRecord, base: BuildRecord | null, v: GuardVerdict): string {
  const line = (j: JourneyRecord) => `- **${j.scenario}**: ${j.reason}`;
  return [
    `## mobius-qa release guard: ${v.block ? '🛑 BLOCK' : '✅ PASS'}`,
    `Build \`${now.build}\` on ${now.platform}${base ? ` vs \`${base.build}\`` : ' (no baseline yet)'} · ${now.journeys.length} journeys`,
    v.new_failures.length ? `### New failures\n${v.new_failures.map(line).join('\n')}` : '',
    v.slow_steps.length ? `### Slower steps\n${v.slow_steps.map(s => `- **${s.scenario}** step ${s.step} (${s.target}): ${(s.before_ms / 1000).toFixed(1)}s → ${(s.now_ms / 1000).toFixed(1)}s`).join('\n')}` : '',
    v.still_failing.length ? `### Still failing (already broken in the baseline)\n${v.still_failing.map(line).join('\n')}` : '',
    v.flakes.length ? `### Flaky (failed, then passed on retry)\n${v.flakes.map(line).join('\n')}` : '',
    v.ui_changes.length ? `### UI changed, journey self-healed\n${v.ui_changes.map(line).join('\n')}` : '',
    v.accessibility_regressions.length ? `### Accessibility\n${v.accessibility_regressions.map(a => `- **${a.scenario}**: unlabeled controls ${a.before} → ${a.now}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

export function saveBuild(dir: string, r: BuildRecord) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${r.platform}-${r.build.replace(/[^\w.-]/g, '_')}.json`), JSON.stringify(r, null, 2));
}
/** The most recent earlier build for this platform with no new bugs (the last good release). */
export function lastGoodBuild(dir: string, platform: string, except: string): BuildRecord | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => f.startsWith(`${platform}-`) && f.endsWith('.json'))
    .map(f => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files) {
    const r = JSON.parse(readFileSync(f, 'utf8')) as BuildRecord;
    if (r.build !== except && !r.journeys.some(j => j.category === 'bug')) return r;
  }
  return null;
}
