---
"ct-catalog-migration-pipeline": patch
---

Diagnostics no longer carry personal data from the input or the API. A `malformed-json` diagnostic now says `Not valid JSON at column N.` instead of passing on the parser's message, which on current Node quotes a piece of the line; a `plan.json` that does not parse is reported the same way. An email address in an API error message (the refused request, a canary's refusal, the sampled reasons of failing operations, the teardown and verify errors) is replaced by `[email]`, in the printed output and in `load-result.json`; the record is still named by its key.
