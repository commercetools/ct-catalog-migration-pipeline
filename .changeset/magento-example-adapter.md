---
"ct-catalog-migration-pipeline": patch
---

An example adapter for Magento Open Source 2.4 in `src/examples/magento/`. It reads a database snapshot, either a mysqldump file (`.sql` or `.sql.gz`, only the catalog tables parsed) or a directory of one NDJSON file per table, and writes a catalog feed plus a report that counts every decision and every loss. It stops on what it cannot decide safely: Adobe Commerce staging tables (`row_id`), a store-view value the feed cannot hold, two used options with the same label, an unknown HTML entity, excess price digits, fractional stock, an unmapped stock source. It is an example to adapt, not a supported adapter: profile the source before relying on any of its output. It is not a pipeline stage, and nothing else in the pipeline changes.
