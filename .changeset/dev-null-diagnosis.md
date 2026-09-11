---
"@elinpf/dsh-ops-shell-tool": patch
---

Translate the `Couldn't open /dev/null` stderr signature into an actionable local-environment diagnosis. When the execution sandbox or the dsh host makes /dev/null unwritable, ssh (and any CLI) dies at startup before any network I/O — the tool result now says so explicitly (`local execution environment failure`, with the `ls -la /dev/null` check and the mknod recreation recipe) instead of letting the model burn steps suspecting credentials, the network, or the remote host.
