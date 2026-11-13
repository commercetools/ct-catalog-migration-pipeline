---
"ct-catalog-migration-pipeline": patch
---

The README gives the engagement its own `.gitignore` (`/source-export/`, `/migration/feed/`, `/migration/out/`) and says why: the pipeline's `.gitignore` covers only its own folder, while the engagement's `out/` sits next to the config, and once customers or orders are in scope those folders hold personal data. The layout no longer calls the engagement's `out/` "gitignored", and the install step is `npm ci --ignore-scripts`, as in CI.
