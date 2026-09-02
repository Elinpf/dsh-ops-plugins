# @elinpf/dsh-ops-access-gate

Per-session credential brokering with human approval for DeepSeek Harness ops mode — owns the authorization ledger and decides ro/rw/deny on every credential resolve.

## What it does

The gate sits between the ops-access registry (`@elinpf/dsh-ops-access`) and every credential resolve: it registers a **pure-decision broker** into that seam that answers `rw` when the calling session holds an unexpired grant for the profile, `ro` otherwise, and `deny` for approval-required kinds (ssh) without a grant or for operator-locked profiles.

- **`request_access` tool** — the model asks for a time-limited grant; the call parks in a pending-request queue until a human decides it in the access panel, and the result reports the TTL actually granted (the human may dial it down).
- **Access panel backend** — 9 HTTP routes (`/ops-access/grants*`, `/ops-access/access-requests*`, `/ops-access/deny|undeny`) plus the `/access` and `/access-all` slash commands. Panel grants are identical in shape and lifetime to request grants.
- **Audit log** — every request, decision, grant, expiry, revoke, lockdown, and ledger reset lands in an append-only JSONL file.
- **Lockdowns** — operator denies persist to `deniedFile` and survive restarts (an incident freeze that silently lifts on restart is no freeze).

## Design notes

- **The gate never sees credential fields.** Kind, profile name, and session id are its entire world — secret material cannot leak through authorization.
- **Session-keyed ledger, lazy expiry.** The preset-plane instance is shared, so grants key on `agent.id`; a lapsed grant is evicted the first time it is consulted (a web session has no dependable end event — TTL is the only reliable boundary).
- **The access panel is the approval channel** (ADR-0004), not dsh's native approval: the native outcome vocabulary cannot carry a human-adjusted TTL. Headless deployments (no web server) fail `request_access` fast with out-of-band guidance.
- **types.ts is pure types** (zero runtime); `src/invariant.ts` is the invariant companion — it reserves package ownership but installs nothing, because the gate owns no session-event shape (its state is the in-process ledger plus the JSONL audit file).
- **Every registration is an effect**, so fiber disposal / HMR unload removes the tool, both commands, all routes, the notice listener, the broker, and the provided `opsAccessGate` service, and settles parked requests as cancelled.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `approvalRequiredKinds` | `['ssh']` | Kinds with no ro tier — any use requires a grant |
| `defaultTtlMinutes` | `30` | Grant lifetime when `request_access` omits `ttlMinutes` |
| `maxTtlMinutes` | `480` | Upper bound for a requested grant lifetime |
| `auditFile` | `~/.dsh-ops/audit.log` | JSONL audit log path (`~` expands) |
| `grantTtlOptions` | `[5, 10, 30]` | TTL choices the access panel offers |
| `pendingRequestTimeoutMinutes` | `5` | How long a parked request awaits a human before auto-rejecting |
| `deniedFile` | `~/.dsh-ops/denied.json` | Persisted lockdown state (survives restarts) |

## Testing

```sh
npm run build
npx vitest run
```

The spec mounts the gate together with the real ops-access core against a mock cordis context (real tmp registry and audit files) and drives the externally observable seams: resolve serves ro vs rw by the ledger, `request_access` parks until the decide route settles it, panel routes grant/revoke directly, TTL expiry and notices behave, and every transition is audited. An HMR-unload suite disposes the gate fiber and asserts every registration surface (tool, commands, routes, listener, broker, service) is removed while core stays mounted.
