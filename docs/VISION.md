# mobius-qa vision

**Every critical journey in every mobile app is watched by an AI that behaves like a real user, catches breakage before customers do, and is guaranteed to never spend money, send messages or leak data.**

Put simply, mobius-qa grows from a test runner into an autonomous mobile reliability engineer.

## The problem it ends

Today, mobile teams find out their checkout, login or booking flow broke when revenue dips, support tickets spike, or someone on call notices hours later.

Unit and UI tests run on test builds with mock data. Nobody continuously checks the real app, on real production backends, the way a user would. That's because it's unsafe (bots might buy things) and brittle (scripts break with every UI change).

mobius-qa makes that safe (via Mobius) and maintainable (via an agent that self-heals).

## How it evolves

| Stage | What mobius-qa is | User experience | Status |
|---|---|---|---|
| 1. Runner | Plain-English scenarios → agent run → evidence-checked verdict + trace | "I wrote a test in English and it ran." | **Built**: verdicts are re-graded against the trace; unsupported claims fail |
| 2. Monitor | Scheduled deterministic replays of production journeys; LLM only on drift; Slack alerts with evidence | "It told me checkout broke 4 minutes after the deploy." | **Built (v1)**: `replay`, `monitor --every`, self-healing on drift, Slack alerts on transitions |
| 3. Release guard | Runs on every build, PR preview and staged rollout; diffs against the last release; can block a rollout | "Version 4.12 broke the coupon flow on Android, so the rollout was paused." | **Built (v1)**: `guard` diffs against the last good build, blocks on new failures and slowdowns; GitHub Actions example. Plus `release`: a full go/no-go (build, store rules, permissions/size diff, journeys, human checklist, staged rollout with monitor-driven halt) |
| 4. Autonomous QA engineer | Crawls the app, proposes journeys, writes and maintains them, triages bug vs. flake vs. UI change, files Jira tickets | "I don't write tests. I approve the ones it suggests and fix the bugs it files." | **Built (v1)**: `discover` proposes journeys; triage (bug / flake / UI change / infra) by retry; Jira tickets with repro steps. Maintaining journeys = self-healing replays |
| 5. Reliability layer | Per-step latency, accessibility, localization, crashes, payment-gateway health, competitor benchmarks | "It's how we know our app works for real users, everywhere, all the time." | **Started**: per-step latency, accessibility count, crash/app-exit detection on every replay. Next: localization, payment-gateway health, competitor benchmarks |

## Principles

- **Safe on production by design.** Every run goes through Mobius policy. Nothing gets paid, sent or deleted, and secrets never reach the model. Never optional.
- **Evidence over opinion.** Every verdict is backed by observations and a trace you can replay. No "the AI says it passed".
- **Cheap enough to run every few minutes.** Explore with the LLM once, then replay deterministically. The LLM only steps in when something changes.
- **Intent, not selectors.** Scenarios describe what a user wants ("book the cheapest non-stop flight"), so they survive redesigns.
- **Fits the existing toolchain.** CI, Slack, Jira and device clouds, without replacing anything.

## What it is not

- Not another "write tests in English" tool competing on price with Drizz, Quash or Maestro.
- Not a device farm.
- Not a replacement for unit tests. It covers the gap they can't: does the real app work for a real user right now?

## How it ties to Mobius

Mobius is the trust layer. mobius-qa is the first product built on it: monitoring production mobile apps is the use case where agent safety is non-negotiable and buyers exist today. Every customer run sharpens Mobius's policy intelligence, which feeds the bigger agent-plane vision.

> **One-liner:** mobius-qa is an AI that uses your app like a real customer, around the clock, on production, and is guaranteed never to spend money or leak data, so you know about broken journeys before your users do.
