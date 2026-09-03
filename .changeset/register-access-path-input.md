---
'@elinpf/dsh-ops': patch
---

ops-access: `register_access` 的文件类字段（kubeconfig、conf、keyring、key）现在也接受单行文件路径——服务端读取后走同一校验落盘，凭证内容不再需要经过模型上下文；路径无对应文件时报错明确点名两种写法（原来是误导性的 "not a YAML mapping"）。`list_access help`、工具 schema 描述与 admin UI 占位文案同步澄清「registry 收路径、工具收内容或路径」的区别。
