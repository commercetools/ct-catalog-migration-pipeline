---
"ct-catalog-migration-pipeline": minor
---

Orders as an opt-in entity (`entities.orders`). An `order` feed record is imported as a snapshot with its order number verbatim: totals as given, a SKU the feed does not declare as a custom line item, and never a `store` or `inventoryMode`. `validate` and `audit` catch what the platform accepts silently (negative amounts, mixed currencies, unresolvable references); `verify` reconciles totals, lines and states; `teardown` deletes an order first, with `dataErasure`, only while it still matches the plan.
