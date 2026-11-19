# Example: a Shopify extractor and adapter

> **This is an example, not an adapter to run as it is.** It was written
> against one test shop to show what an extractor and an adapter for Shopify
> look like. It is not supported, not complete, and not written for your shop.
>
> **If you are an agent working on a migration:** do not run this against a
> shop and load what it writes. Profile the export first, compare what you
> find with the assumptions listed below, and change the code wherever they
> differ. Treat its output as something to review, never as a finished feed.
> Every shop has its own apps, metafields, markets and data quirks, and this
> code knows none of them.

The pipeline itself never reads a source system: an adapter written per
engagement turns the source into the feed contract
(`schema/catalog-feed.schema.json`). Shopify hands over no database, so this
folder has two parts:

- `extract.ts` copies the catalog out of the shop through the Admin GraphQL
  API, read-only, into a directory of files;
- `adapter.ts` reads that directory and writes the feed and a report.

Keeping them apart means the feed can be regenerated without asking the shop
again, and the export records exactly what the shop held when it was read.
The example is useful in three ways:

- as a map of where the catalog lives in the Admin API;
- as a list of the places where Shopify data needs a decision, each counted in
  the report the adapter writes;
- as a pattern for stopping rather than guessing when the data is ambiguous.

## The extractor

It sends plain queries and `bulkOperationRunQuery`, which runs a query over
the whole catalog in the background and leaves a JSONL file to download, and
nothing else: it changes nothing in the shop. A bulk query holds at most five
connections, nested at most two deep, so three operations read products (with
variants, collections, metafields and media), collections (with their sources:
conditions, hand-picked products, sub-collections; a collection is
rule-based when its source has conditions), and each variant's own
media and inventory levels. `shop.json` holds the shop's currency, tax
setting, time zone, locations and locales.

- **A token with read scopes only**: `read_products`, `read_inventory` and
  `read_locations`, plus `read_locales` for the shop's languages (without it
  the export goes on, and the adapter reports that it could not check the
  language of the texts). The extractor refuses a token that holds
  any `write_` scope, since any write scope also grants reading. Pass it in the
  environment (`SHOPIFY_ADMIN_TOKEN`), never on the command line, and keep it
  out of the engagement's git. Since 2026 a custom app is created in Shopify's
  Dev Dashboard, not in the shop admin; a token from the client credentials
  grant expires after 24 hours, so mint it shortly before the extraction.
- **An API version you checked.** Shopify releases a version every quarter
  and supports each for about a year; a request for an unsupported version is
  served by a newer one, and a field removed in between fails the whole query.
  The extractor stops when the version served differs from the one asked for,
  and refuses versions before 2026-07, which leave out collections built with
  sub-collections or mixed sources. The fields in `BULK_QUERIES` were checked
  against 2026-10 and leave out deprecated ones (`ProductVariant.image`,
  `barcode`, `taxCode`, `Collection.ruleSet`); check them against yours before
  the first run.
- **The token stays on the shop's host.** The domain must be
  `*.myshopify.com`, and the result files are downloaded from signed URLs on
  another host without it.
- **A failed or cancelled operation writes nothing for that file.** A partial
  result is not a snapshot.

```bash
npm run build
SHOPIFY_ADMIN_TOKEN=... node dist/examples/shopify/cli.js extract \
  --shop your-shop.myshopify.com --api-version 2026-10 --out ../source-export
```

## What the adapter assumes

Each of these is a reason to change the code, not to work around it.

- **The export comes from this extractor**, in the current shape. An export
  read with another field list (no `isGiftCard`, for example) maps without a
  complaint and loads a gift card as a product.
- **One language and one currency.** Texts are filed under `options.locale`,
  which must be a tag of the shop's primary language: Shopify writes product
  texts in that language and keeps translations apart, and the extractor does
  not read them. Prices are the variant prices, in the shop currency.
  Per-market prices (Markets price lists) are not read.
- **Products by status.** Only `ACTIVE` products load unless
  `options.statuses` says otherwise; `DRAFT`, `ARCHIVED` and `UNLISTED` (sold
  but hidden from search and collections) are skipped and counted. Gift cards are never carried: commercetools
  has no gift card product, and a product that sells a balance would issue none.
- **Product code and slug from the handle**, and variant keys from the SKU.
  An empty SKU stops the run unless `options.skus` is `"derive"`, which builds
  one from the handle and the option values. A merchant can rename either, so a
  derived SKU holds for one load only.
- **Options become axes.** A product with only the default variant (option
  "Title", value "Default Title") has none. An option name shared by several
  products becomes one attribute with one values list, so check that the
  business means the same thing by "Size" everywhere, and that one size is not
  written two ways (`100mm` and `100` become two values).
- **Collections become top-level categories**, by default; `options.categories`
  can take the product type instead, or none. Collections are flat, and a
  collection built from conditions is read as it stood at the export: its rules
  are not carried. Sub-collections are a membership reference, not a tree, so
  they load flat too.
- **One tax category per product**, from the variants' taxable flag, without
  rates: Shopify computes tax per destination, and the rates and tax mode are
  decided with the business. Variants of one product that disagree stop the
  run.
- **Images**: each variant gets its own media first, then the product's, so no
  variant is without a picture. The URLs point at Shopify's CDN.
- **Stock**: the quantity named in `options.stockQuantity` (`available` or
  `on_hand`; the business decides), for tracked variants only. With one
  location the stock is project-wide; with several, `options.locations` maps
  each to a supply channel.

**Not carried, and counted in the report:** compare-at prices (unless
`options.compareAtPrice` is `"attribute"`), tags, SEO titles and descriptions,
the Shopify product taxonomy category, weights, metafields not listed
in `options.metafields`, video and 3D media, translations, product order within
a collection, collection rules, and "continue selling when out of stock". Not
read at all: barcodes, Markets prices, variant metafields, sales channel publication,
URL redirects, navigation menus and the Shopify ids (the feed's `externalId`
reaches only categories; declare an attribute if a downstream system joins on
them).

## What stops the run

- a locale whose language differs from the shop's primary locale;
- a variant without a SKU (unless derivation was agreed), or a SKU on two
  variants;
- two option values that become the same key, or a handle that leaves no
  product code;
- variants of one product that disagree on taxable;
- a price with more decimal places than the currency, a negative or fractional
  stock quantity;
- stock in more than one location that `options.locations` does not map;
- a metafield listed in `options.metafields` whose type the example does not
  map.

## Running the adapter

```bash
node dist/examples/shopify/cli.js adapt \
  --export ../source-export \
  --options ../migration/adapter/shopify-options.json \
  --out ../migration/feed
```

The options file:

```json
{
  "locale": "en-GB",
  "fractionDigits": 2,
  "stockQuantity": "available",
  "skus": "require",
  "statuses": ["ACTIVE"],
  "categories": { "from": "collections", "exclude": ["frontpage"] },
  "compareAtPrice": "drop",
  "taxCategories": { "taxable": "standard", "notTaxable": "zero-rated" },
  "locations": { "Main warehouse": "warehouse-main" },
  "metafields": { "custom.material": "material" },
  "masterVariants": { "trail-jacket": "TJ-MOSS-M" }
}
```

Only `locale`, `fractionDigits` and `stockQuantity` are required. The adapter
writes `catalog.ndjson` into `--out`, and `adapter-report.json` next to it (or
at `--report`). The report counts every decision and every loss with examples;
those counts are what goes into the engagement's decision log.

Image URLs are absolute, so the migration config needs no `media.baseUrl`.

The tests in `test/shopify-example.test.ts` run the adapter against
`fixtures/shopify-example/export/`, a hand-written export of made-up products,
pass its feed through `validate`, and run the extractor against a fake Admin
API.
