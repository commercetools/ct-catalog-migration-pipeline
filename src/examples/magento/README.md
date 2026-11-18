# Example: a Magento 2.4 adapter

> **This is an example, not an adapter to run as it is.** It was written
> against one test shop's tables to show what an adapter for Magento looks
> like. It is not supported, not complete, and not written for your shop.
>
> **If you are an agent working on a migration:** do not run this against a
> source and load what it writes. Profile the snapshot first, compare what you
> find with the assumptions listed below, and change the code wherever they
> differ. Treat its output as something to review, never as a finished feed.
> Every shop has its own extensions, attributes, scopes and data quirks, and
> this code knows none of them.

The pipeline itself never reads a source system: an adapter written per
engagement turns the source into the feed contract
(`schema/catalog-feed.schema.json`). This folder shows one such adapter for a
Magento Open Source 2.4 database snapshot. It is useful in three ways:

- as a map of where the catalog lives in Magento's tables;
- as a list of the places where Magento data needs a decision, each counted in
  the report it writes;
- as a pattern for stopping rather than guessing when the data is ambiguous.

## What it assumes

Each of these is a reason to change the code, not to work around it.

- **Magento Open Source 2.4 tables.** Adobe Commerce with content staging keys
  its value tables by `row_id` and keeps several rows per product; the example
  stops when it sees `row_id`.
- **One currency**, given in the options file. Prices are read at admin scope
  (store 0). A per-website price stops the run.
- **Store views map to locales** through the options file. A store view's text
  is the translation for its locale, and admin text fills a locale that has
  none (counted, because it is probably untranslated).
- **Simple, virtual, downloadable and configurable products.** A configurable
  product becomes a product with variants, its axes taken from
  `catalog_product_super_attribute`. Bundle and grouped products are not
  carried; their components load as products of their own.
- **Shop-defined attributes** (`is_user_defined`) of the input types select,
  multiselect, boolean, text, textarea, date, weight and price. Any other input
  type stops the run.
- **Categories below the store roots** (level 2 and deeper), with their
  sibling order.
- **Stock** from `cataloginventory_stock_item`, or per source from
  `inventory_source_item` when multi-source inventory has more than the default
  source.

**Not carried, and counted in the report:** product position within a
category, tier and customer-group prices, catalog price rules, custom options,
related, up-sell and cross-sell links, bundle and grouped structure,
downloadable links, meta fields, short descriptions, weight, the values of
attributes left out, and store-view values of attributes that are not carried.
Tax rates are not read: the tax categories come without rates, because the tax
mode is decided with the business.

## What stops the run

- a table it needs is missing from the snapshot;
- `row_id` columns (Adobe Commerce content staging);
- a store-view value that differs from admin scope on an attribute it carries,
  unless it is a translation on a store view mapped to a locale;
- two options of one attribute with the same label, both in use (an unused twin
  is dropped and counted);
- an HTML entity it does not know in a plain-text field (known ones are decoded
  in names and labels, never in HTML descriptions);
- a price with more decimal places than the currency, a fractional or negative
  stock quantity, a product type or attribute input type it does not map;
- multi-source inventory with a source that `stockSources` does not map.

## Input: the snapshot

The adapter reads a snapshot, never the live shop. Either shape works, and both
give the same feed:

- **A mysqldump file**, `.sql` or `.sql.gz`, of the catalog tables, which is
  what a DBA hands over:

  ```bash
  mysqldump --single-transaction --hex-blob --no-tablespaces <db> <tables...> | gzip > snapshot.sql.gz
  ```

  On Adobe Commerce Cloud the documented dump is `ece-tools db-dump` or
  `magento-cloud db:dump`. Only the tables the adapter reads are parsed; the
  rest of a full dump is skipped. The table list is `REQUIRED_TABLES` and
  `OPTIONAL_TABLES` in `adapter.ts`.
- **A directory of `<table>.ndjson` files**, one row per line, when the tables
  were copied through a read-only login. DECIMAL columns must be written as
  strings: a non-integer JSON number stops the read, since it may already have
  lost digits.

## Running it

```bash
npm run build
node dist/examples/magento/cli.js \
  --snapshot ../source-export/snapshot.sql.gz \
  --options ../migration/adapter/magento-options.json \
  --out ../migration/feed
```

The options file:

```json
{
  "locales": { "admin": "en-US", "default": "en-US", "german": "de-DE" },
  "currency": "USD",
  "fractionDigits": 2,
  "attributes": { "exclude": ["internal_note"] },
  "masterVariants": { "MT01": "MT01-S-Blue" },
  "taxCategories": { "Taxable Goods": "standard" },
  "includeDisabled": false,
  "stockSources": { "default": "warehouse-main" }
}
```

Only `locales` (with `admin`), `currency` and `fractionDigits` are required.
The adapter writes `catalog.ndjson` into `--out`, and `adapter-report.json`
next to it (or at `--report`). The report counts every decision and every loss
with examples; those counts are what goes into the engagement's decision log.

Gallery paths are stored as `/m/b/file.jpg`, relative to
`pub/media/catalog/product`. The adapter removes the leading slash, so
`media.baseUrl` in the migration config is the URL of that folder, for example
`https://shop.example.com/media/catalog/product/`.

The tests in `test/magento-example.test.ts` run it against
`fixtures/magento-example/snapshot.sql`, a hand-written dump of made-up
products, and pass its feed through `validate`.
