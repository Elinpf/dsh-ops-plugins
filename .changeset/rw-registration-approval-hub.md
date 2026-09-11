---
"@elinpf/dsh-ops-access-hub": minor
---

Add the registration-request approval queue (ADR-0008). Agents can now submit tier-registration requests that take effect only after human approval: `POST /requests` queues `{kind,name,tier,fields,envelope?,reason?}` (audited as `request`), `GET /requests?status=` lists metadata only (field names + byte sizes, never values), `GET /requests/:id` returns full field values for pre-approval review (admin only), and `POST /requests/:id/decide` approves (the tier is written) or rejects (audited as `approve`/`reject`). Requests persist in the encrypted document; a decided request's `fields` are wiped immediately so secret material never lingers in a settled record.
