# @elinpf/dsh-ops-tool-prometheus

The `prometheus` tool for DeepSeek Harness ops mode — resolves a named `prometheus` profile through the ops-access seam and runs a PromQL query directly against the Prometheus HTTP API (`/api/v1/query` / `/api/v1/query_range`), injecting the bearer token automatically. No shell, no curl heredocs.

## What it does

The model calls `prometheus` with a `cluster` (profile name) and a `query` (PromQL). With no time arguments it runs an instant query at now; `time` (RFC3339 or unix seconds) pins the instant; `start`+`end`+`step` (all three) make it a range query. The tool resolves the profile on every call (no caching — credential edits take effect immediately), reads the optional bearer-token file, sends the request with a 30 s timeout (`timeoutSec`, 1–600 s, overrides per call), and returns the suite-standard `{ exitCode, stdout, stderr, command, error? }` result.

## Design notes

- **HTTP, not shell.** The Prometheus API is a plain GET with URL-encoded parameters — routing it through `ctx.shell` + curl only added quoting bugs (the motivation for this tool: a real incident session hand-wrote ~15 curl heredocs, 5 of them broken). The result shape, output schema, and render duplicate the `@elinpf/dsh-ops-shell-tool` contract verbatim so the four consumer tools cannot drift apart.
- **Failure taxonomy.** A PromQL rejection (`status: "error"` in the API envelope) is the server's answer: `exitCode: 1`, `errorType: error` on stderr. Transport failures — connection refused, timeout (`AbortSignal.timeout`), caller abort, non-Prometheus HTTP status — are `exitCode: -1` with the cause named in `error`, never a bare -1.
- **No secret material in band.** The token travels only in the `Authorization` header, which is never logged or echoed; every returned string is additionally scrubbed against the token value defensively. The server URL is plain connection metadata and DOES appear in the displayed command (`prometheus <cluster> query='...' @ http://host:9090/api/v1/query`) so the agent can confirm which instance it hit. A token-file read failure is reported without its path — credential paths never reach the model.
- **Size guards.** Range results are capped at 100 series (rest omitted with a note), 50 points per series (evenly sampled, first and last kept, noted in the series header), and ~100KB of stdout (cut with a truncation note pointing at narrower selectors / larger steps).
- **Registration is an effect.** The tool registers via `ctx.effect(() => ctx.tools.register(...))`, so fiber disposal / HMR unloads it cleanly. The `./invariant` subpath registers a no-op invariant companion: the tool is stateless and owns no session events.

## Configuration

Schemastery schema, one option:

| Key | Default | Meaning |
|---|---|---|
| `timeoutMs` | `30000` | Per-call HTTP timeout for Prometheus queries (ms). Slow queries may need more. |

## Testing

```sh
npm run build     # tsc → lib/ (plugins load lib/, not src/)
npx vitest run    # unit tests against a mock ctx + injected fake fetch — no network
```

The suite covers instant/range routing and URL encoding, argument-shape rejections (time vs start/end/step, partial range), bearer-token injection/scrubbing, the Prometheus/HTTP/network/timeout failure mapping, the series/points/bytes size guards, render purity, export shape (`.` / `./invariant` / `./types`), and HMR unload.
