import type { RunResult } from './runner.ts';

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const BADGE: Record<string, string> = { pass: '#1a7f37', fail: '#cf222e', blocked: '#9a6700', error: '#6e7781' };

/** Self-contained HTML report (no external assets). */
export function renderReport(results: RunResult[], title = 'Mobius QA report'): string {
  const count = (s: string) => results.filter(r => r.verdict.status === s).length;
  const cost = results.reduce((a, r) => a + r.costUsd, 0);
  const rows = results.map((r, i) => `
    <details${r.verdict.status !== 'pass' ? ' open' : ''}>
      <summary><span class="b" style="background:${BADGE[r.verdict.status]}">${r.verdict.status}</span>
        <b>${esc(r.scenario.title)}</b> <small>${esc(r.device.platform)} · ${(r.durationMs / 1000).toFixed(0)}s · ${r.trace.length} actions · $${r.costUsd.toFixed(2)}</small></summary>
      <p>${esc(r.verdict.summary)}</p>
      <table><tr><th>Expectation</th><th>Met</th><th>Evidence</th></tr>
        ${r.verdict.expectations.map(e => `<tr><td>${esc(e.text)}</td><td>${e.met ? '✅' : '❌'}</td><td>${esc(e.evidence)}</td></tr>`).join('')}
      </table>
      ${r.verdict.bugs.length ? `<h4>Bugs</h4><ul>${r.verdict.bugs.map(b => `<li><b>[${esc(b.severity)}] ${esc(b.title)}</b><br><i>Steps:</i> ${esc(b.steps)}<br><i>Evidence:</i> ${esc(b.evidence)}</li>`).join('')}</ul>` : ''}
      <details><summary>Trace (${r.trace.length} tool calls)</summary><ol>
        ${r.trace.map(t => `<li${t.isError ? ' class="err"' : ''}><code>${esc(t.tool)}</code> <small>+${(t.t / 1000).toFixed(1)}s</small> <code>${esc(JSON.stringify(t.input)).slice(0, 300)}</code><pre>${esc(t.output.slice(0, 600))}</pre></li>`).join('')}
      </ol></details>
    </details>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{--bg:#fff;--fg:#1f2328;--mut:#656d76;--line:#d0d7de;--code:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8d96a0;--line:#30363d;--code:#161b22}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;max-width:1100px;margin:0 auto;padding:16px}
small{color:var(--mut)} .b{color:#fff;border-radius:10px;padding:1px 8px;font-size:12px;margin-right:6px;text-transform:uppercase}
details{border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:10px 0} summary{cursor:pointer}
table{border-collapse:collapse;width:100%} td,th{border-top:1px solid var(--line);padding:6px;text-align:left;vertical-align:top}
pre,code{background:var(--code);font-size:12px;white-space:pre-wrap;word-break:break-word} li.err code:first-child{color:#cf222e}
</style></head><body>
<h1>${esc(title)}</h1>
<p>${results.length} scenarios · <b style="color:${BADGE.pass}">${count('pass')} pass</b> · <b style="color:${BADGE.fail}">${count('fail')} fail</b> · ${count('blocked')} blocked · ${count('error')} error · est. cost $${cost.toFixed(2)}</p>
${rows}
</body></html>`;
}
