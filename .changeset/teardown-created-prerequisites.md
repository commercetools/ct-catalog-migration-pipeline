---
"ct-catalog-migration-pipeline": minor
---

`teardown --include-created-prerequisites` also deletes the stores, channels and customer groups a load of this plan created, and the tax categories (it covers `--include-created-tax-categories`). Opt-in, off by default, listed in the dry run, and never a resource the project held before: `load --execute` now records the channels, customer groups and stores it created in `out/created-prerequisites.json`, as it already did for tax categories, and teardown deletes only keys on that list that the plan names. Stores go first, then channels and customer groups, after customers, inventory and products are gone; one the API still refuses to delete is reported as a failure and the run is marked incomplete. A ledger written by an earlier version names only tax categories, so nothing else is offered for removal after such a load.
