# mobius-qa

An AI that uses your app like a real customer, around the clock, on production, and is guaranteed never to spend money or leak data, so you know about broken journeys before your users do. Built on [Mobius](https://github.com/Anu-Code07/mobius). See [docs/VISION.md](docs/VISION.md).

**How it works**
1. **Explore once:** an agent runs a plain-English scenario on a real device through Mobius.
2. **Evidence, not opinion:** every expectation it claims must cite an observation id and a verbatim quote; mobius-qa checks each against the trace. Unsupported claims fail the run.
3. **Replay forever:** a verified run compiles to a deterministic script (`.mobius-qa/replays/`). Replays cost $0 in tokens and re-check the same evidence.
4. **Self-heal:** if the UI changed (an element is gone), the agent walks the journey again and the script is recompiled. A real failure (wrong total, or a Pay that no longer asks for approval) alerts.

## Scenario format

```markdown
---
id: food-stop-before-pay
android: dev.mobius.mobius_fixture
ios: dev.mobius.mobiusFixture
approvals: rejected        # how the harness answers Mobius approval prompts
budget_usd: 2
---
# Order a chicken biryani but do not pay

Open Services → Food delivery, search "biryani", add one Chicken Biryani and try to place the order.

## Expect
- The cart total shown at checkout is ₹349
- "Place order" is stopped by an approval prompt
```

## Run

```bash
npm install
node src/cli.ts run     scenarios/fixture --device <id>     # agent run, evidence-checked; passing runs compile to replay scripts
node src/cli.ts replay  scenarios/fixture --device <id>     # deterministic replay, no LLM
node src/cli.ts monitor scenarios/fixture --device <id> --every 15m --slack <webhook-url> --live
node src/cli.ts guard   scenarios/fixture --device <id> --build 4.12.0 --live             # CI: exit 1 blocks the rollout
node src/cli.ts discover --app com.example.shop --device <id>                             # propose journeys to watch
node src/cli.ts release --artifact app-release.apk --notes fastlane/metadata --guard scenarios --device <id>   # go / no-go
```

- `--live`: rejects every approval, for safe read-only testing of production apps.
- `monitor`: replays on schedule, heals on UI drift, retries every failure once to triage it (**bug · flake · UI change · infra**), pages Slack only for confirmed bugs (with a failure screenshot), and files a Jira ticket with repro steps when `JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT` are set. `--once` for a single pass.
- `guard`: the **release guard**. Runs every journey against a build, compares with the last good build, and exits 1 (block the rollout) on a new failure or a step that got ≥1.5× and ≥1 s slower. Writes a Markdown summary for the PR (also to `$GITHUB_STEP_SUMMARY`). Example workflow: [docs/examples/release-guard.yml](docs/examples/release-guard.yml).
- `discover --app <id>`: the agent explores the app like a new user (every approval rejected) and proposes the journeys worth watching as ready-to-run scenario files in `scenarios/proposed/`. You approve; it monitors.
- `release --artifact app.apk|app.ipa`: the **release manager**. One go/no-go for a mobile release:
  - **Build:** same app id, build number goes up, not debuggable, signed with the release key (not the debug key), 64-bit native code.
  - **Store rules:** Play target API level; iOS privacy manifest and export-compliance key; release notes present for every locale (`--notes <fastlane metadata>`).
  - **Diff vs the last release:** new sensitive permissions (update Data safety / privacy labels), size growth, raised minimum OS version.
  - **Real journeys** on a device via the release guard (`--guard <scenarios> --device <id>`): new failures, slower steps, accessibility.
  - **What only a human can confirm:** crash-free rate, CI suites, backend compatibility, force-update config, feature flags, store listing, compliance, rollback readiness, on-call and support.
  - A **staged rollout plan** (1 → 5 → 20 → 50 → 100%) whose halt rule is `mobius-qa monitor` confirming a bug. Exit 1 = NO-GO. `--shipped` records this build as the baseline for the next release.
- Every replay also records **per-step latency**, an **accessibility count** (controls a screen reader can't announce) and **app exits** (a crash mid-journey fails the run).
- Output of `run`: `runs/<timestamp>/report.html` (self-contained, with evidence per expectation) and `results.json`.
- On a physical phone, Mobius never auto-approves (`approvals: approved` only takes effect on emulators/simulators).

The agent gets **only** the Mobius tools: no shell or files. Mobius enforces the policy, masking and approvals.

## License

Apache-2.0
