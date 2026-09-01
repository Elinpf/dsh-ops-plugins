# @deepseek-ai/dsh-ops-access-ui

Browser half carrier for @-mentioning ops-access credential profiles: the host row exists only for client-bundle discovery; candidate data, admin routes, and mention expansion all live in `@deepseek-ai/dsh-ops-access`.

## What it does

Ships the web client bundle (`dsh.client.platform: "web"`, esbuild → `lib/client.js`) that registers five surfaces in the dsh web app:

- **`access` @-mention source** on the input trigger — candidates from `GET /ops-access/list`; picking inserts the ready-made `@[kind/name](dsh-access:...)` mention (codec is identity; the preset-plane listener in ops-access core expands it). rw-only entries are badged "ro 未注册（可由 rw 派生）".
- **`settings.section` entry** (`ops-access-admin`, label 凭证管理) — credential management page: merged ro/rw entry list with per-tier validation and probe chips, JSON-Schema-driven add/edit form, delete with a confirm strip.
- **Two ops-panel pages** — `access` (访问授权: approve/reject pending `request_access` calls with a TTL picker, grant/extend/revoke this session's grants, deny/undeny lockdowns) and `access-all` (授权总览: the same across all sessions).
- **Input-dock badge** — red-dot count of parked `request_access` calls: own-session count comes off the runtime snapshot (zero polling), delegated sub-session requests poll every 4 s; clicking opens the approval deck.

All data flows over plain HTTP routes served by `@deepseek-ai/dsh-ops-access` (preset plane, next to the data). A 404 (ops preset not mounted) or a network failure degrades every surface gracefully — empty lists, inline messages, never a white screen.

## Design notes

- **Empty host row**: the web app's ClientModuleRegistry discovers client bundles by scanning the composed HOST cordis entries for `dsh.client`, so the package must stay mounted host-plane; the host-side `apply` is intentionally empty.
- **Why no route lives here**: reaching the preset-realm `opsAccess` service from a host-plane external package would dual-instance dsh internals (module-private state silently diverges) — cross-plane data goes through HTTP, per repo convention.
- **Secrets never cross the wire**: admin routes return envelopes and validation status only; credential file fields are write-only after save.
- **Registration discipline**: every surface is registered inside `ctx.effect` (or the inject-scoped effect), so fiber disposal/HMR unloads it. The spec runs every collected disposer and asserts all five surfaces disappear; `injectCSS` guards on the DOM marker (not a module-level flag) so an HMR reload never appends a duplicate `<style>` tag.

## Configuration

None — `Config` is `z.object({})`.

## Testing

```sh
npm run build   # tsc → lib/ (index/types/invariant) + esbuild → lib/client.js
npx vitest run  # export shape, @ source, settings.section, admin/panel API
                # functions, 404/network degradation, badge derivation,
                # HMR unload (all disposers remove all five surfaces)
```

## Known limitations

- Panels and the dock badge poll (3–4 s) while open; there is no push channel.
- The edit form cannot show stored credential file content (write-only after save) — textareas show a placeholder instead.
- The panel registers only when the ops-panel seam (`opsPanels`) is composed; without it the @ source and the settings section are unaffected.
