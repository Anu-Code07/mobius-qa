# mobius-qa vision

**An AI QA engineer that tests your mobile app the way your users will break it: it finds the bugs your team didn't think to test, proves each one with evidence, and never spends money, sends messages or leaks data while doing it.**

## The problem

Developers test the path they built. Users take every other path.

They:
- tap Pay twice
- lose network in a lift
- rotate the phone mid-checkout
- set their font to extra-large
- switch the app to Hindi
- deny the location permission
- come back after the app was killed in the background

That's where crashes, stuck spinners, wrong prices, clipped buttons and "undefined" on screen come from. Those bugs reach production because nobody had the time to try thousands of combinations on real devices.

Scripted UI tests only check what someone wrote down. They break with every redesign, and they never ask "what else could go wrong here?"

## What mobius-qa does

**1. Learns the app on its own.** It explores every screen, button and route, and builds a map of the app: its screens, the flows between them, and what each screen is for (login, form, list, cart, checkout, settings). No scripts and no selectors.

**2. Thinks like a hostile user.** For every screen on the map, it generates the cases developers miss, from a library that grows with every app it tests:

| Category | Examples |
|---|---|
| Input | empty, maximum length, emoji, Hindi and other scripts, leading spaces, pasted text, script/SQL-shaped strings, invalid formats |
| Interaction | double-tap submit, rapid back, tap during loading, swipe mid-animation, keyboard covering the button |
| Lifecycle | rotate mid-flow, background/foreground, app killed and restored, deep link straight into a screen, session expiry |
| Environment | offline, slow 2G, airplane mode mid-request, low battery, dark mode, largest font, another app language, permission denied, push notification mid-flow |
| Devices | small and large screens, Android and iOS, emulators, simulators and real phones |

**3. Spots bugs without being told what "correct" is.** Detectors flag problems on any screen, with no test spec:
- **Stability:** crashes and ANRs; blank screens, spinners that never stop, screens you can't leave.
- **Bad text:** "null", "undefined", "NaN", stack traces, untranslated keys like `home.title`, English left on a Hindi screen.
- **Layout:** clipped, overlapping or off-screen text and buttons (comparing what's drawn with what the app declares).
- **Money:** a price or total that changes between cart and checkout.
- **Accessibility:** unlabeled controls, touch targets that are too small, duplicate labels.
- **Performance:** slow launch, janky frames, memory that climbs as you navigate, battery drain.
- **Visual change:** screens that changed from the approved baseline.

**4. Proves every finding.** Each bug arrives with:
- a video
- screenshots
- the exact steps
- the device and its state (network, locale, font, theme)
- logs and the crash trace
- a one-command replay that reproduces it

No finding is reported without evidence from the device. Flakes are re-run, and only reproducible bugs are filed.

**5. Keeps the bug fixed.** Every confirmed bug becomes a replay test. It runs deterministically on every build, costs no AI tokens, and repairs itself when the UI changes.

## How it runs

```
explore → map → generate edge cases → attack on a device matrix → detect → reproduce → report → regress forever
```

- **On a laptop:** `mobius-qa hunt --app com.example`. It explores, attacks and hands you an HTML report of findings.
- **In CI:** on every build, a release guard re-runs the regression suite plus a focused hunt on the screens that changed, and can block the release.
- **On a schedule:** production journeys are replayed every few minutes, with alerts the moment one breaks.
- **On a fleet:** Android emulators, iOS simulators and real phones, sharded across machines.
- **Into your tools:** Jira tickets, Slack alerts and GitHub checks.

## Why it can be trusted on a real app

mobius-qa drives devices through **Mobius**, the safety layer for AI agents on phones.
- Anything that pays, books, sends or deletes needs a human's approval, and is rejected by default while testing.
- Secrets are masked before the AI sees them.
- Every action is checked against what's really on screen, and every step is in a signed audit log.

That's what makes it safe to point at production backends and real accounts, where the real bugs live.

## Principles

- **Find what wasn't written down.** The value is in the bugs nobody planned for.
- **Evidence over opinion.** Every verdict is backed by what the device showed, plus a replay. "The AI says it failed" is never enough.
- **Safe by construction.** Mobius policy on every action, never optional.
- **Cheap to run constantly.** The AI explores and invents; deterministic replays repeat. Tokens are spent only on new ground and on change.
- **Intent, not selectors.** It understands what a screen is for, so tests survive redesigns.
- **Fits the toolchain.** CI, Jira, Slack and device clouds, without replacing them.

## Roadmap

| Stage | What it adds | Status |
|---|---|---|
| **1. Runner** | Plain-English journeys → agent run → evidence-checked verdict | Built |
| **2. Monitor** | Deterministic replays on a schedule; AI only on drift; Slack alerts | Built |
| **3. Release guard** | Runs per build, diffs against the last good release, can block a rollout; release go/no-go | Built |
| **4. Explorer** | Autonomous crawl → app map; screen classification | Next |
| **5. Bug hunter** | Edge-case generator + detector pack + device-state matrix | Next |
| **6. Findings** | Video, repro, replay, dedup, severity; one HTML report; Jira | Next (Jira built) |
| **7. Learning library** | Every bug found anywhere becomes a new edge case for every app | Later |

Stages 4–6 build directly on capabilities Mobius already ships:
- **Exploration:** snapshot, screen diff, wait-until-idle, OCR.
- **Device state:** dark mode, font scale, app locale, network, battery, permissions, GPS routes.
- **Diagnostics:** crash watching, performance reports, accessibility audits, visual checks, bug reports.
- **Media and replay:** screen recording, and flow recording and replay.

## How we measure it

- **Bugs found that the team didn't already know about**, per app per week. The number that matters.
- **Precision:** the share of reported bugs that developers confirm as real (target above 90%).
- **Time from build to first finding** (minutes, not days).
- **Escapes:** production bugs that a hunt could have caught but didn't. Each one becomes a new edge case.

## What it is not

- Not a tool for writing tests in English faster. It finds the tests you would never have written.
- Not a device farm. It runs on yours, or on any device cloud.
- Not a replacement for unit tests. It covers what they can't: the real app, on a real device, in the hands of an unpredictable user.

> **One-liner:** mobius-qa is the QA engineer who tries everything your users will: every input, every interruption, every setting. It shows you exactly what broke, with proof, before your users find it.
