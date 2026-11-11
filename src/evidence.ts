// Evidence over opinion: the agent may claim an expectation is met only by citing what the device actually returned.
// Every claim is checked against the recorded trace; a claim without matching evidence is not a pass.
import type { TraceStep, Verdict } from './runner.ts';

export interface Evidence {
  /** An observation id from a tool result ("o12") or a trace step ("step:7"). */
  ref: string;
  /** Text copied verbatim from that tool result. */
  quote: string;
}

/** Compare text as a person reads it: JSON escapes undone (\\n, \\"), quotes and punctuation spacing ignored. */
export const norm = (s: string) => s.replace(/\\[nrt]/g, ' ').replace(/\\(["'\\/])/g, '$1').toLowerCase()
  .replace(/[“”"'`]/g, '').replace(/\s+/g, ' ').trim();
/** A quote is found if it appears verbatim, or (when it spans adjacent screen elements) every word of it appears. */
export function quoteIn(output: string, quote: string): boolean {
  const o = norm(output), q = norm(quote);
  if (!q) return false;
  if (o.includes(q)) return true;
  const words = q.split(/[\s·:,()\[\]]+/).filter(w => w.length > 0);
  return words.length > 1 && words.every(w => o.includes(w));
}

/** The trace step a ref points at: "step:N" (1-based), or the step whose output carries that observation id. */
export function resolveRef(ref: string, trace: TraceStep[]): TraceStep | null {
  const m = /^step:(\d+)$/.exec(ref.trim());
  if (m) return trace[Number(m[1]) - 1] ?? null;
  const id = ref.trim();
  if (!/^o\d+$/.test(id)) return null;
  const re = new RegExp(`"observation_id"\\s*:\\s*"${id}"|"id"\\s*:\\s*"${id}:e\\d+"`);
  return trace.find(s => re.test(s.output)) ?? null;
}

export interface Check { expectation: string; ok: boolean; why: string }

/**
 * Re-grade the agent's verdict from evidence. An expectation counts as met only if it cites at least one ref whose
 * tool output contains the quoted text. The run passes only if every expectation is met by verified evidence.
 */
export function verifyVerdict(v: Verdict, trace: TraceStep[]): { verdict: Verdict; checks: Check[] } {
  const checks: Check[] = v.expectations.map(e => {
    if (!e.met) return { expectation: e.text, ok: false, why: 'agent reported not met' };
    if (!e.evidence.length) return { expectation: e.text, ok: false, why: 'claimed met without evidence' };
    for (const ev of e.evidence) {
      const step = resolveRef(ev.ref, trace);
      if (!step) return { expectation: e.text, ok: false, why: `evidence ref ${ev.ref} not found in the trace` };
      if (!quoteIn(step.output, ev.quote)) return { expectation: e.text, ok: false, why: `quote "${ev.quote.slice(0, 60)}" is not in ${ev.ref}` };
    }
    return { expectation: e.text, ok: true, why: `verified in ${e.evidence.map(x => x.ref).join(', ')}` };
  });
  const allOk = checks.length > 0 && checks.every(c => c.ok);
  const lied = v.status === 'pass' && !allOk;
  const verdict: Verdict = {
    ...v,
    expectations: v.expectations.map((e, i) => ({ ...e, met: checks[i]!.ok, verification: checks[i]!.why })),
    status: v.status === 'pass' && !allOk ? 'fail' : v.status,
    summary: lied ? `Evidence check failed: ${checks.filter(c => !c.ok).map(c => `"${c.expectation}" (${c.why})`).join('; ')}. Agent said: ${v.summary}` : v.summary,
  };
  return { verdict, checks };
}
