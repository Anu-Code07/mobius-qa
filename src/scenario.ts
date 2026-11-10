import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/** A plain-English QA scenario. One Markdown file = one test. */
export interface Scenario {
  id: string;
  title: string;
  /** App id per platform (Android package / iOS bundle id). */
  app: { android?: string; ios?: string };
  /** How the simulated human answers Mobius approval prompts in this run. */
  approvals: 'approved' | 'rejected';
  goal: string;
  expect: string[];
  maxTurns: number;
  budgetUsd: number;
  file: string;
}

/**
 * Format:
 *   ---
 *   id: food-stop-before-pay
 *   android: dev.mobius.mobius_fixture
 *   ios: dev.mobius.mobiusFixture
 *   approvals: rejected
 *   ---
 *   # Title
 *   Goal text…
 *   ## Expect
 *   - expectation
 */
export function parseScenario(text: string, file = 'inline.md'): Scenario {
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const meta: Record<string, string> = {};
  for (const line of (fm?.[1] ?? '').split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1]!] = m[2]!.trim();
  }
  const body = fm ? text.slice(fm[0].length) : text;
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? basename(file, '.md');
  const [beforeExpect, afterExpect = ''] = body.split(/^##\s+Expect\s*$/im);
  const goal = beforeExpect!.replace(/^#\s+.+$/m, '').trim();
  const expect = afterExpect.split('\n').map(l => /^\s*[-*]\s+(.+)$/.exec(l)?.[1]?.trim()).filter((x): x is string => !!x);
  const approvals = meta.approvals ?? 'rejected';
  if (approvals !== 'approved' && approvals !== 'rejected') throw new Error(`${file}: approvals must be approved|rejected`);
  if (!goal) throw new Error(`${file}: missing goal text`);
  if (!expect.length) throw new Error(`${file}: add an "## Expect" list`);
  if (!meta.android && !meta.ios) throw new Error(`${file}: set android: and/or ios: app id`);
  return {
    id: meta.id ?? basename(file, '.md'),
    title,
    app: { ...(meta.android ? { android: meta.android } : {}), ...(meta.ios ? { ios: meta.ios } : {}) },
    approvals,
    goal,
    expect,
    maxTurns: Number(meta.max_turns ?? 60),
    budgetUsd: Number(meta.budget_usd ?? 3),
    file,
  };
}

export const loadScenario = (file: string) => parseScenario(readFileSync(file, 'utf8'), file);
