# mobius-qa

An AI mobile QA engineer. Write test scenarios in plain English; an agent runs them on a real Android or iOS device through [Mobius](https://github.com/Anu-Code07/mobius) and returns a verdict with evidence, bugs and a full action trace.

> Early stage. The runner and report are built; end-to-end runs are next.

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
node src/cli.ts run scenarios/fixture --device <adb-or-simulator-id> [--live] [--mobius ../mobius]
```

- `--live`: rejects every approval, for safe read-only testing of production apps.
- Output: `runs/<timestamp>/report.html` (self-contained) and `results.json`.

The agent gets **only** the Mobius tools: no shell or files. Mobius enforces the policy, masking and approvals.

## License

Apache-2.0
