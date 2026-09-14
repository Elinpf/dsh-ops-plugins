---
"@elinpf/dsh-ops-access-hub": patch
---

离线导入(`import --data-dir`)补上 kind/name 字符集校验:此前 `applyToStore` 直写 store,绕过了 HTTP 面的 `NAME_PATTERN` 校验,手改的注册表可以把 API 既无法 resolve 也无法删除的脏条目写进 hub。`NAME_PATTERN` 移至 store 模块,HTTP 面与导入面共用同一份。
