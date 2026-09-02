---
'@elinpf/dsh-ops-tool-trace': patch
---

Fixed the npm tarball missing four runtime modules (`doctrine.js`, `node-status.js`, `reminders.js`, `session-forests.js`): the `files` field enumerated only four of the seven compiled outputs, so the published package could not be imported when installed from the registry. The field now ships the whole `lib/` directory.
