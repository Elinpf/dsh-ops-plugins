---
"@elinpf/dsh-ops-access": minor
"@elinpf/dsh-ops-access-ui": minor
---

Agent-submitted rw registration requests with human approval (ADR-0008). The `register_access` tool gains `tier: "rw"` and `reason` parameters: instead of writing (rw stays human-approved), it validates the fields exactly like a real write (provider content hooks + zod schema) and queues a registration request on the hub (hub mode only; yaml mode fails with guidance). The admin settings section (凭证管理) gains a "待审批注册申请" block listing pending requests; reviewing one shows the full field contents (the only place secrets render in this UI — seeing the material is the point of approval), and approving writes the tier via new core proxy routes (`/ops-access/admin/requests`, `/detail`, `/decide`) so the browser never holds the hub token.
