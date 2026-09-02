# @elinpf/dsh-ops-access-ceph

运维模式 Ceph 凭证 provider — 校验 `ceph` 注册表条目(ceph.conf + keyring)、展开路径,并在保存时用集群真实 cephx caps 探测声称的 ro/rw tier。

## 功能

按 ops-access 三角色拆分,一种凭证一个 provider:core 拥有注册表和 `ctx.opsAccess` 服务;本包只提供 ceph 这一种 — 一个 zod 条目 schema 加字段处理。

- **条目 schema**:`{ conf, keyring, name? }` — 管理 UI 接受 ceph.conf 和 keyring 的内容;core 将其写入 `~/.dsh-ops/credentials/` 下的受管文件并存路径。`name` 是 cephx 实体(缺省 `client.admin`)。
- **process**:展开两个路径开头的 `~`,供工具的 `--conf`/`--keyring` 参数使用。
- **validateContent**:保存时的粘贴防护 — conf 必须有 `[global]` 和 `mon_host`;keyring 必须在 `[client.x]` 段下有缩进的严格 base64 `key =` 行。只查结构,不做连通性检查。
- **能力探测**(ticket 10):保存时通过 `ceph auth get` 重读实体的 caps,与声称的 tier 对比。ro 只有在没有任何 cap 授予写权限时才通过(`rwx`/`wx` 这类权限束算写,`allow` 关键字本身不算,pool 限定符不影响判定)。失败降级为 `unverifiable` — 收紧的 ro 实体无法自读 caps 是正常现象,不是错误。
- **derivationDoc**:ro 自助注册配方(`client.<id>-ro`,mon/osd/mds/mgr 均 `allow r`),通过 `list_access` 的 help 暴露。

## 设计要点

- 结构校验在 provider,连通性在探测:粘贴损坏在保存时就报错,而不是到连接时才冒出 "cannot parse buffer: Malformed input"。
- 末尾换行归一化是 core 的职责(`normalizeTrailingNewline: true` 选择加入)— provider 不再因缺末尾换行而拒绝。
- 探测的 stderr 只按子串分类、从不外泄:ceph 错误信息可能携带文件路径。

## 配置

Schemastery `Config`,一个字段:

- `probeTimeoutMs`(数字,默认 `10000`)— 保存时 `ceph auth get` 调用的超时。慢集群可能需要调大。

## 安装

ops preset 的 `agent.cordis.yml` 中的 provider 行:

```yaml
- id: ops-access-ceph
  name: '@elinpf/dsh-ops-access-ceph'
```

注册走 `registerAccessProvider`(延迟 `ctx.inject` + effect 生命周期,HMR 可卸载)— 绝不静态 `inject` `opsAccess`,那会死锁加载器。

## 测试

```sh
npm run build      # tsc → lib/
npx vitest run     # schema、process、粘贴防护、探测分类、注册/HMR 卸载
```

无需集群:活体探测测试指向不存在的路径,断言结果降级为 `unverifiable` 且不泄露路径。
