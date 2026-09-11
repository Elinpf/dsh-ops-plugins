---
"@elinpf/dsh-ops-access-hub": patch
---

Harden store durability and audit-log resilience. `save()` now uses a unique tmp name per write (concurrent saves can no longer collide on `tmp-{pid}-{ms}`), fsyncs the payload before the atomic rename, and fsyncs the directory after it — a power cut cannot leave a torn or zero-length data file. `audit()` detects a torn tail line (crash mid-append) and starts a fresh line instead of fusing the next record onto it; `readAudit()` skips unparseable lines instead of throwing on every future read.
