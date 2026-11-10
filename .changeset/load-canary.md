---
"ct-catalog-migration-pipeline": minor
---

The first request of a customer or order stage in `load --execute` holds one record, and the load reads that record's result before it sends the rest. The Import API has no dry run, so no offline stage can show that it accepts the shape a mapper sends; a refused shape now costs one failed operation instead of one per record. `imported` sends the rest; `unresolved` (a reference arriving on its own) sends it with a warning; `validationFailed`, `rejected`, `partiallyImported`, `canceled`, a result that stays `processing` for two minutes and a result that cannot be read stop the stage and everything after it, name the record and the API's errors, and create no store. The request bodies of a dry run show the one-record request (`load-requests.json` flags it as `canary`), and an executed run records the result under `canary` in `load-result.json`.
