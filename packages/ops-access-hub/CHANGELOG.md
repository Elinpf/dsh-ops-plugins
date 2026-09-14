# @elinpf/dsh-ops-access-hub

## 0.2.0

### Minor Changes

- 5c1fc5f: Add the registration-request approval queue (ADR-0008). Agents can now submit tier-registration requests that take effect only after human approval: `POST /requests` queues `{kind,name,tier,fields,envelope?,reason?}` (audited as `request`), `GET /requests?status=` lists metadata only (field names + byte sizes, never values), `GET /requests/:id` returns full field values for pre-approval review (admin only), and `POST /requests/:id/decide` approves (the tier is written) or rejects (audited as `approve`/`reject`). Requests persist in the encrypted document; a decided request's `fields` are wiped immediately so secret material never lingers in a settled record.

### Patch Changes

- 5c1fc5f: Harden store durability and audit-log resilience. `save()` now uses a unique tmp name per write (concurrent saves can no longer collide on `tmp-{pid}-{ms}`), fsyncs the payload before the atomic rename, and fsyncs the directory after it — a power cut cannot leave a torn or zero-length data file. `audit()` detects a torn tail line (crash mid-append) and starts a fresh line instead of fusing the next record onto it; `readAudit()` skips unparseable lines instead of throwing on every future read.
