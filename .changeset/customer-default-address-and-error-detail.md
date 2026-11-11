---
"ct-catalog-migration-pipeline": minor
---

A customer's default shipping or billing address has to be one of that kind's addresses: the Import API refuses the whole request otherwise ("defaultShippingAddress must be a valid index in shipping addresses array"), a customer with no address list counts as not listing it, and nothing offline said so. `validate` (`customer-default-address-not-listed`, by address code) and `audit` (the same code, by position) now refuse it, and the adapter adds the address to `shippingAddresses` or `billingAddresses`.

`load` now prints what the API said was wrong. A refused request shows the `errors` of the response body (`InvalidField: …`) after the generic message, and when the summary shows failing operations the load reads a bounded sample of them (the first 20 per state) and prints the reasons grouped, with a count and one example record (`operation-errors`), instead of leaving the reader to read the operations by hand. A read that fails adds nothing and hides no count.
