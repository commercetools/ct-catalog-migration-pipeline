---
"ct-catalog-migration-pipeline": patch
---

The credential hosts are checked before anything is sent. `CTP_REGION` is checked against the known regions whenever it builds a host; before, the check was skipped as soon as `CTP_API_URL` was set, while the region still built the auth URL the client secret is sent to. `CTP_AUTH_URL`, `CTP_API_URL` and `CTP_IMPORT_URL` must be https (plain http only to a loopback host, for a local mock), and a value that is not a URL is refused. A host outside commercetools.com is not refused, since a proxy is legitimate, but the credentials summary every command prints now shows the auth host and warns about such a host.
