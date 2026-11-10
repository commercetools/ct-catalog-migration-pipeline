# ct-catalog-migration-pipeline

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
