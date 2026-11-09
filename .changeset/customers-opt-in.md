---
"ct-catalog-migration-pipeline": minor
---

Customers as an opt-in entity. A `customer` feed record, refused by `validate` unless the config sets `entities.customers: true`, is planned as a `CustomerImport` with `authenticationMode: ExternalAuth` and no password, loaded after the catalog, checked by `audit`, reconciled by `verify` and removed first by `teardown`, with `dataErasure`. Diagnostics and the review decision name customer codes and counts, never emails.

`entities.customers: false` ignores customer records with one warning instead of failing; leaving it unset still refuses them. An order naming a customer who is not migrated is refused (`order-customer-not-loaded`).
