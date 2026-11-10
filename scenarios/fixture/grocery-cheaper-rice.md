---
id: grocery-cheaper-rice
android: dev.mobius.mobius_fixture
ios: dev.mobius.mobiusFixture
approvals: rejected
budget_usd: 1.5
---
# Which rice is cheaper per kg? (reasoning, read-only)

Open Services → Groceries. Compare "Rice 1kg" with buying two "Rice 500g" packs. Do not order.

## Expect
- Rice 1kg costs ₹72 and Rice 500g costs ₹40
- The conclusion is that the 1 kg pack is cheaper (₹72 vs ₹80)
