---
"ct-catalog-migration-pipeline": minor
---

`load --only <stage>[,<stage>]` runs just the named stages, in plan order, and touches nothing else: the platform stages (channels, customer groups, tax categories, stores) are skipped unless named, so resending one stage cannot unpublish products or change what an earlier stage left. A restricted run writes `load-result-only-<stages>.json` (or `load-requests-only-…` for a dry run) beside the full run's record instead of over it.

Orders are create-only, so `load` now reads which order numbers the project already holds and leaves them out of the sends, on a full load as well. An unreadable project stops an `--execute` before anything is created and only warns on a dry run.
