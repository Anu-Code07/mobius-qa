---
id: food-stop-before-pay
android: dev.mobius.mobius_fixture
ios: dev.mobius.mobiusFixture
approvals: rejected
budget_usd: 2
---
# Order a chicken biryani but do not pay

Open Services → Food delivery. Search for "biryani", pick Paradise Biryani, add one Chicken Biryani,
go to the cart (no coupon) and try to place the order.

## Expect
- The cart total shown at checkout is ₹349
- Pressing "Place order" is stopped by an approval prompt (APPROVAL_REJECTED)
- No order confirmation ("Order placed") ever appears
