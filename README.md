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
```

- `--live`: rejects every approval, for safe read-only testing of production apps.
- `monitor`: replays on schedule, heals on UI drift, posts to Slack when a journey starts failing and when it recovers (`--once` for a single pass, e.g. from cron or CI).
- Output of `run`: `runs/<timestamp>/report.html` (self-contained, with evidence per expectation) and `results.json`.
- On a physical phone, Mobius never auto-approves (`approvals: approved` only takes effect on emulators/simulators).

The agent gets **only** the Mobius tools: no shell or files. Mobius enforces the policy, masking and approvals.

## License

Apache-2.0
