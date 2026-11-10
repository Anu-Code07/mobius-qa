---
id: flight-cheapest-nonstop
android: dev.mobius.mobius_fixture
ios: dev.mobius.mobiusFixture
approvals: rejected
budget_usd: 2
---
# Find the cheapest non-stop flight (read-only)

Open Services → Flights. Search BLR to DEL for "20 Nov" with "Non-stop only" turned on.
Report the cheapest non-stop flight. Do not book.

## Expect
- Only non-stop flights are listed
- The cheapest non-stop flight is Akasa QP-1102 at ₹4899
