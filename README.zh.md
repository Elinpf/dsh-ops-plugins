# dsh-ops-plugins

[English](README.md) | 中文

面向运维场景的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件集：把 dsh agent 变成生产事件排查员——按名字解析 kubectl / ceph / ssh 凭证、对集群执行真实的只读命令、把整个排查过程组织成一棵树。

插件集以单个 npm 包 `@elinpf/dsh-ops` 安装，它把颗粒化的 `@elinpf/dsh-ops-*` 包作为依赖整体带入（共 16 个包，锁步版本）。一切都是 Cordis 插件；本仓库的 [`ops-preset.yml`](ops-preset.yml) 是参考组合。

## 为什么需要它

- **凭证永不进入模型上下文。** 访问档案只携带路径和连接参数；agent 看到的是档案*名字*，永远看不到字段值。`list_access` 只回答名字和描述。
- **默认只读，读写需显式授权。** 访问门按会话代理每一次凭证使用：ro/rw 分层、人工审批、可收回的授权，以及记录每次授权与收回的审计日志。
- **诚实的工具输出。** `kubectl` / `ceph` / `ssh` 工具每次调用只拼一条命令；真实路径在命令串、stdout、stderr 到达模型或会话日志之前，一律擦回展示 token。
- **排查是树，不是清单。** `trace` 工具把事件响应组织成扩散-收敛树——步骤、里程碑、保留在案的死胡同——在 web UI 里以 git-graph 风格面板渲染。
- **agent 认识你的环境。** 确定性扫描器构建环境清单（命名空间、deployment、ceph 池、主机、相互关系、Prometheus 印证），TTL 驱动刷新——agent 基于「实际存在什么」推理，而不是靠猜。
- **方法论，而不是玄学。** 提示词通道往系统提示词注入几行核心方法论 + 每步提醒；完整文档按需拉取，token 成本保持低廉。

## 环境要求

- DeepSeek Harness，`dsh-v0.1.0-rc` 线（见 [harness 仓库](https://github.com/deepseek-ai/deepseek-harness)）
- `@deepseek-ai/cordis` v4（自动带入）
- dsh 宿主机上的集群侧二进制：`kubectl`（及集群网络可达）；`ceph`/`rbd`/`rados` 与 `ssh` 仅在使用对应提供方时需要

## 安装

把单一的部署包安装进你的 dsh profile——它依赖全部颗粒化的 `@elinpf/dsh-ops-*` 包，并携带宿主层行（trace 面板、`@` 引用选择器、ops 面板）：

```sh
dsh plugin --profile <name> add @elinpf/dsh-ops
```

颗粒化包仍在 npm 上发布，供高级组合取用；`@elinpf/dsh-ops-shell-tool` 是共享库，作为依赖自动到达——不要直接挂载它。

## 部署

插件在被 agent 预设挂载之前是不生效的。`@elinpf/dsh-ops` 自带 `ops` 预设——即参考组合——并附一个 `dsh-ops` 小工具来落盘它：

1. **安装预设**——到你的 agents home（默认 `~/.agents`）：

   ```sh
   npx @elinpf/dsh-ops preset install
   ```

   这会把 `~/.agents/.agent-presets/ops/`（`preset.yml` + `agent.cordis.yml`）写到内置预设旁边。agents home 不在默认位置时，传 `--agents-home <dir>` 或设 `DSH_AGENTS_HOME`。

2. **让 profile 指向它**——在 profile 的 `cordis.patch.yml` 里加：

   ```yaml
   - id: agent-presets
     config:
       default: ops
   ```

   `ops` 预设会顶替上游 `session-reference` 行的 `@` 引用选择器；如果你使用 ops 的访问档案选择器，把该行禁用（`- id: session-reference` 加 `disabled: true`），让 ops 的来源占住这个位置。

3. **重启 profile**（`dsh plugin add/remove` 和预设改动都需要重启；web 表面上不热生效）。

4. **登记凭证。** 档案在 `~/.dsh-ops/access.yaml` 里一次性登记——只携带路径和连接参数，永远不携带密钥材料。agent 可按需拉取格式文档（`list_access` 带 `help: true`），web 管理界面支持带保存时校验的登记。

验证：打开 web UI，在 ops 预设上开一个会话——`list_access` 列出你的档案、`kubectl` 命令正确解析、trace 面板正常渲染、rw 凭证的使用会弹出审批请求而不是直接执行。

## 卸载

1. 把 profile 的默认预设切回去，或移除 ops 预设（`npx @elinpf/dsh-ops preset remove`），重启 profile。
2. 移除插件包：

   ```sh
   dsh plugin --profile <name> remove @elinpf/dsh-ops
   ```

3. 再次重启 profile。
4. 按需删除数据目录 `~/.dsh-ops/`——凭证登记表（`access.yaml`）、环境清单（`environment.yaml`）、以及档案引用的凭证文件本身（keyring、kubeconfig、SSH 私钥）。

卸载不影响你的集群：本插件集的所有凭证都只是对你自有文件的只读引用。

## 安全说明

- 密钥材料不进入服务、日志、错误信息或模型上下文——凭证文件在登记时写入一次，之后只按路径引用。
- 访问门的威胁模型是「防误操作，不防恶意」：它拦截并审计误写，不是对抗同 UID 恶意进程的防线。
- 设计决策在 [`docs/adr/`](docs/adr/)；领域词汇表（中文）在 [`CONTEXT.md`](CONTEXT.md)。
