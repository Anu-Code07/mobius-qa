// Bring your Maestro flows, get them guarded. A Maestro flow becomes a Mobius replay script (so every tap goes through
// Mobius policy, masking and audit, replays cost no tokens) plus a plain-English scenario (so when the UI drifts, the
// agent can heal it, and monitor / guard / fleet / release treat it like any other journey).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';
import type { ReplayScript, ReplayStep, Selector } from './replay.ts';

export interface Converted { script: ReplayScript; scenario: string; unsupported: string[]; steps_human: string[] }

const ANY = '*';
/** Maestro matches visible text or a resource id; Mobius re-finds the element by either. */
const sel = (q: { text?: string; id?: string }): Selector => ({ role: ANY, text: q.text ?? null, label: null, rid: q.id ?? null });
const KEY: Record<string, string> = { enter: 'enter', back: 'back', home: 'home', 'recent apps': 'recents', recents: 'recents' };

/** Expand ${VAR} from -e / env, like Maestro does. */
const expand = (s: string, env: Record<string, string>) => s.replace(/\$\{(\w+)\}/g, (_, k) => env[k] ?? process.env[k] ?? `\${${k}}`);

export function convertFlow(file: string, o: { platform: 'android' | 'ios'; env?: Record<string, string>; app?: string }): Converted {
  const env = o.env ?? {};
  const steps: ReplayStep[] = [];
  const checks: { expectation: string; quotes: string[] }[] = [];
  const unsupported: string[] = [];
  const human: string[] = [];
  let app = o.app ?? '';

  const walk = (path: string, depth: number) => {
    if (depth > 8) { unsupported.push(`runFlow nesting too deep at ${basename(path)}`); return; }
    const docs = parseAllDocuments(readFileSync(path, 'utf8')).map(d => d.toJS());
    const [header, commands] = docs.length > 1 ? [docs[0] ?? {}, docs[1] ?? []] : [{}, docs[0] ?? []];
    if (header?.env) for (const [k, v] of Object.entries(header.env)) env[k] ??= String(v);
    if (!app && header?.appId) app = expand(String(header.appId), env);
    for (const raw of (Array.isArray(commands) ? commands : [])) {
      const [cmd, arg] = typeof raw === 'string' ? [raw, undefined] : Object.entries(raw)[0] ?? ['', undefined];
      const a: any = typeof arg === 'string' ? expand(arg, env) : arg;
      const target = (x: any): { text?: string; id?: string } | null => typeof x === 'string' ? { text: expand(x, env) }
        : x && (x.text || x.id) ? { ...(x.text ? { text: expand(String(x.text), env) } : {}), ...(x.id ? { id: expand(String(x.id), env) } : {}) } : null;
      switch (cmd) {
        case 'launchApp': {
          const id = typeof a === 'object' && a?.appId ? expand(a.appId, env) : app;
          steps.push({ tool: 'open_app', args: { app_id: id } }); human.push(`Open the app (${id}).`); break;
        }
        case 'tapOn': case 'longPressOn': case 'doubleTapOn': {
          const t = target(a);
          if (!t) { unsupported.push(`${cmd} by point/index (${JSON.stringify(arg)}): re-record by text or id`); break; }
          const mode = cmd === 'longPressOn' ? 'long' : cmd === 'doubleTapOn' ? 'double' : undefined;
          steps.push({ tool: 'tap', args: mode ? { mode } : {}, target: sel(t) });
          human.push(`${mode === 'long' ? 'Long-press' : mode === 'double' ? 'Double-tap' : 'Tap'} "${t.text ?? t.id}".`); break;
        }
        case 'inputText': steps.push({ tool: 'type', args: { text: String(a) } }); human.push(`Type "${a}".`); break;
        case 'inputRandomEmail': case 'inputRandomText': case 'inputRandomNumber': case 'inputRandomPersonName':
          unsupported.push(`${cmd}: random input isn't replayable; use inputText with a fixed value`); break;
        case 'assertVisible': {
          const t = target(a);
          if (!t?.text) { unsupported.push(`assertVisible by id only (${JSON.stringify(arg)}): add the visible text`); break; }
          steps.push({ tool: 'wait_for', args: { text_visible: t.text } });
          checks.push({ expectation: `"${t.text}" is visible`, quotes: [t.text] }); human.push(`Check that "${t.text}" is shown.`); break;
        }
        case 'assertNotVisible': {
          const t = target(a);
          if (!t?.text) { unsupported.push(`assertNotVisible by id only`); break; }
          steps.push({ tool: 'wait_for', args: { text_gone: t.text } }); human.push(`Check that "${t.text}" is not shown.`); break;
        }
        case 'scroll': steps.push({ tool: 'scroll', args: { direction: 'down' } }); human.push('Scroll down.'); break;
        case 'scrollUntilVisible': {
          const t = target(a?.element ?? a);
          const dir = String(a?.direction ?? 'DOWN').toLowerCase();
          if (!t?.text) { unsupported.push('scrollUntilVisible without element text'); break; }
          for (let i = 0; i < 3; i++) steps.push({ tool: 'scroll', args: { direction: dir } }); // ponytail: fixed 3 scrolls; replay resync skips extras
          steps.push({ tool: 'wait_for', args: { text_visible: t.text } }); human.push(`Scroll ${dir} until "${t.text}" is visible.`); break;
        }
        case 'swipe': {
          const dir = String(a?.direction ?? '').toLowerCase();
          if (!dir) { unsupported.push(`swipe by coordinates (${JSON.stringify(arg)})`); break; }
          steps.push({ tool: 'swipe', args: { direction: dir } }); human.push(`Swipe ${dir}.`); break;
        }
        case 'back': steps.push({ tool: 'press_key', args: { key: 'back' } }); human.push('Go back.'); break;
        case 'pressKey': {
          const k = KEY[String(a).toLowerCase()];
          if (!k) { unsupported.push(`pressKey ${a}`); break; }
          steps.push({ tool: 'press_key', args: { key: k } }); human.push(`Press ${k}.`); break;
        }
        case 'openLink': steps.push({ tool: 'open_url', args: { url: String(typeof a === 'object' ? a.link : a) } }); human.push(`Open ${typeof a === 'object' ? a.link : a}.`); break;
        case 'runFlow': {
          const f = typeof a === 'string' ? a : a?.file;
          if (!f || (typeof a === 'object' && a?.when)) { unsupported.push(`runFlow ${a?.when ? 'with when: conditions' : 'with inline commands'}`); break; }
          const sub = resolve(dirname(path), f);
          if (!existsSync(sub)) { unsupported.push(`runFlow ${f}: file not found`); break; }
          walk(sub, depth + 1); break;
        }
        // Mobius waits for the UI to settle after every action; these are already covered.
        case 'waitForAnimationToEnd': case 'hideKeyboard': case 'takeScreenshot': case 'stopApp': case 'clearState': break;
        case 'extendedWaitUntil': {
          const t = target(a?.visible);
          if (t?.text) { steps.push({ tool: 'wait_for', args: { text_visible: t.text } }); human.push(`Wait until "${t.text}" is shown.`); }
          break;
        }
        default: unsupported.push(String(cmd));
      }
    }
  };
  walk(file, 0);
  if (!app) throw new Error(`${file}: no appId (set it in the flow or pass --app)`);
  const id = basename(file).replace(/\.ya?ml$/, '');
  const script: ReplayScript = { scenario: id, platform: o.platform, app, compiled_at: new Date().toISOString(), steps, checks };
  // The scenario lets the agent heal the journey when the UI drifts; every approval is rejected by default.
  const scenario = `---\nid: ${id}\n${o.platform}: ${app}\napprovals: rejected\nbudget_usd: 2\n---\n# ${id} (imported from Maestro)\n\n` +
    `${human.join('\n')}\n\n## Expect\n${(checks.length ? checks.map(c => c.expectation) : ['The flow completes without errors']).map(e => `- ${e}`).join('\n')}\n`;
  return { script, scenario, unsupported, steps_human: human };
}

export function writeImport(c: Converted, scenariosDir: string, scriptsDir: string, platform: string) {
  mkdirSync(scenariosDir, { recursive: true }); mkdirSync(scriptsDir, { recursive: true });
  const md = join(scenariosDir, `${c.script.scenario}.md`);
  writeFileSync(md, c.scenario);
  writeFileSync(join(scriptsDir, `${c.script.scenario}.${platform}.json`), JSON.stringify(c.script, null, 2));
  return md;
}
