---
id: cab-cheapest
android: dev.mobius.mobius_fixture
ios: dev.mobius.mobiusFixture
approvals: approved
budget_usd: 2
---
# Book the cheapest cab

Open Services → Book a cab. Pickup "Koramangala", drop "Airport". Choose the cheapest ride and book it.

## Expect
- The cheapest option is Bike at ₹89 and it is the one selected
- The booking completes and shows the driver details
- The ride OTP is not visible to you (it is masked as [redacted])
