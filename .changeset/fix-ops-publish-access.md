---
'@elinpf/dsh-ops': patch
---

Add `publishConfig.access: "public"` — the 0.1.4 publish of this new scoped package failed with npm E402 (scoped packages default to private), so the meta package never reached the registry while its 15 dependencies did.
