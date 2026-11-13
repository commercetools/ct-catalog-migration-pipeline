---
"ct-catalog-migration-pipeline": patch
---

Every file the pipeline writes into `out/` (`plan.json`, `load-requests.json`, `load-result.json`, `teardown-result.json`, `progress.log` and the rest) is now readable by its owner only (`0600`), also when it overwrites a file of an earlier run, and an `out/` the pipeline creates is `0700`. A directory that already exists keeps its mode, because `--out` can name any directory. Once customers or orders are in scope these files hold names, email addresses and postal addresses, which Node's default mode left readable by every account on the machine. A clean `verify` of a plan with customers or orders now ends with a reminder naming the local copies of that data and saying to delete them once the migration no longer needs them, keeping `plan.json` until any trial load is torn down.
