# ct-catalog-migration-pipeline

## 0.4.0

### Minor Changes

- [#24](https://github.com/commercetools/ct-catalog-migration-pipeline/pull/24) [`732b0df`](https://github.com/commercetools/ct-catalog-migration-pipeline/commit/732b0df830c0928650cd2c1d77c37ffa9041077b) Thanks [@kafis](https://github.com/kafis)! - A customer's default shipping or billing address has to be one of that kind's addresses: the Import API refuses the whole request otherwise ("defaultShippingAddress must be a valid index in shipping addresses array"), a customer with no address list counts as not listing it, and nothing offline said so. `validate` (`customer-default-address-not-listed`, by address code) and `audit` (the same code, by position) now refuse it, and the adapter adds the address to `shippingAddresses` or `billingAddresses`.
  
  `load` now prints what the API said was wrong. A refused request shows the `errors` of the response body (`InvalidField: …`) after the generic message, and when the summary shows failing operations the load reads a bounded sample of them (the first 20 per state) and prints the reasons grouped, with a count and one example record (`operation-errors`), instead of leaving the reader to read the operations by hand. A read that fails adds nothing and hides no count.

- [#24](https://github.com/commercetools/ct-catalog-migration-pipeline/pull/24) [`732b0df`](https://github.com/commercetools/ct-catalog-migration-pipeline/commit/732b0df830c0928650cd2c1d77c37ffa9041077b) Thanks [@kafis](https://github.com/kafis)! - The first request of a customer or order stage in `load --execute` holds the record that shows the most (a customer with an address, an order with a custom line item; when no single record shows every structure, the few that together do, at most five), chosen by which fields a record carries and never by their values, and the load reads that result before it sends the rest. The Import API has no dry run, so no offline stage can show that it accepts the shape a mapper sends; a refused shape now costs one failed operation instead of one per record. `imported` sends the rest; `unresolved` (a reference arriving on its own) sends it with a warning; `validationFailed`, `rejected`, `partiallyImported`, `canceled`, a result that stays `processing` for two minutes and a result that cannot be read stop the stage and everything after it, name the record and the API's errors, and create no store. The request bodies of a dry run show that request (`load-requests.json` flags it as `canary`), and an executed run records the result, with every record of the request, under `canary` in `load-result.json`.

- [#24](https://github.com/commercetools/ct-catalog-migration-pipeline/pull/24) [`732b0df`](https://github.com/commercetools/ct-catalog-migration-pipeline/commit/732b0df830c0928650cd2c1d77c37ffa9041077b) Thanks [@kafis](https://github.com/kafis)! - `load --only <stage>[,<stage>]` runs just the named stages, in plan order, and touches nothing else: the platform stages (channels, customer groups, tax categories, stores) are skipped unless named, so resending one stage cannot unpublish products or change what an earlier stage left. A restricted run writes `load-result-only-<stages>.json` (or `load-requests-only-…` for a dry run) beside the full run's record instead of over it.
  
  Orders are create-only, so `load` now reads which order numbers the project already holds and leaves them out of the sends, on a full load as well. An unreadable project stops an `--execute` before anything is created and only warns on a dry run.

- [#24](https://github.com/commercetools/ct-catalog-migration-pipeline/pull/24) [`732b0df`](https://github.com/commercetools/ct-catalog-migration-pipeline/commit/732b0df830c0928650cd2c1d77c37ffa9041077b) Thanks [@kafis](https://github.com/kafis)! - `teardown --include-created-prerequisites` also deletes the stores, channels and customer groups a load of this plan created, and the tax categories (it covers `--include-created-tax-categories`). Opt-in, off by default, listed in the dry run, and never a resource the project held before: `load --execute` now records the channels, customer groups and stores it created in `out/created-prerequisites.json`, as it already did for tax categories, and teardown deletes only keys on that list that the plan names. Stores go first, then channels and customer groups, after customers, inventory and products are gone; one the API still refuses to delete is reported as a failure and the run is marked incomplete. A ledger written by an earlier version names only tax categories, so nothing else is offered for removal after such a load.

## 0.3.0

### Minor Changes

- [#23](https://github.com/commercetools/ct-catalog-migration-pipeline/pull/23) [`9012c6f`](https://github.com/commercetools/ct-catalog-migration-pipeline/commit/9012c6f8bed4767eb098aa9ba94c62ce3936c858) Thanks [@kafis](https://github.com/kafis)! - Customers as an opt-in entity. A `customer` feed record, refused by `validate` unless the config sets `entities.customers: true`, is planned as a `CustomerImport` with `authenticationMode: ExternalAuth` and no password, loaded after the catalog, checked by `audit`, reconciled by `verify` and removed first by `teardown`, with `dataErasure`. Diagnostics and the review decision name customer codes and counts, never emails.
  
  `entities.customers: false` ignores customer records with one warning instead of failing; leaving it unset still refuses them. An order naming a customer who is not migrated is refused (`order-customer-not-loaded`).

- [#23](https://github.com/commercetools/ct-catalog-migration-pipeline/pull/23) [`9012c6f`](https://github.com/commercetools/ct-catalog-migration-pipeline/commit/9012c6f8bed4767eb098aa9ba94c62ce3936c858) Thanks [@kafis](https://github.com/kafis)! - Orders as an opt-in entity (`entities.orders`). An `order` feed record is imported as a snapshot with its order number verbatim: totals as given, a SKU the feed does not declare as a custom line item, a line item that names its variant by key as well as by SKU (the Import API refuses the SKU alone), and never a `store` or `inventoryMode`. `validate` and `audit` catch what the platform accepts silently (negative amounts, mixed currencies, unresolvable references); `verify` reconciles totals, lines and states; `teardown` deletes an order first, with `dataErasure`, only while it still matches the plan.
  
  `entities.orders: false` ignores order records with one warning instead of failing; leaving it unset still refuses them.

### Patch Changes

- Runtime dependencies changed since v0.2.0:
  
  - @commercetools/importapi-sdk: 7.1.2 -> 7.2.0
  - @commercetools/platform-sdk: 9.7.0 -> 9.8.0
  - @commercetools/ts-client: 5.1.1 -> 5.2.0

## 0.2.0

### Minor Changes

- [#19](https://github.com/commercetools/ct-catalog-migration-pipeline/pull/19) [`4cb157d`](https://github.com/commercetools/ct-catalog-migration-pipeline/commit/4cb157db9d4f9a2afa353336faed0500678865ca) Thanks [@kafis](https://github.com/kafis)! - First tagged release. The pipeline is fetched as a source archive of a GitHub Release instead of being cloned, so a release is the version a reader records. `package.json` was still at 0.1.0 and had not followed the changes since; this release is the first version number that names a tree.
