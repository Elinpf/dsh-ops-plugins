# dsh-ops-plugins

面向运维场景的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件集：凭证代理、shell 工具、调查树、环境清单，以及把它们组装起来的 `ops` 预设。一切都是 Cordis 插件；15 个包以 `@elinpf/dsh-ops-*` 为名发布到 npm，锁步版本（「插件集 vX」）。

## 你能得到什么

一个做生产事件排查（而不是写代码）的 agent：

- **凭证不进上下文** — 档案只携带路径和连接参数（`~/.dsh-ops/access.yaml`）；登记表每次解析现读现校验。`list_access` 只报名字和描述，永远不报字段值。
- **访问门** — 凭证使用按会话代理，ro/rw 分层、人工审批、审计日志。默认只读；读写需要显式授权，且可收回。
- **诚实的 shell 工具** — `kubectl` / `ceph` / `ssh` 工具按名字解析档案、每次调用拼一条命令；真实路径在到达模型或日志之前，一律从命令串、stdout、stderr 擦回展示 token。
- **调查树** — `trace` 工具把事件排查组织成扩散-收敛树（步骤、里程碑、死胡同），web UI 以 git-graph 风格面板渲染。
- **环境清单** — 确定性扫描器（扫描 → 分类 → 关联 → Prometheus 印证 → `~/.dsh-ops/environment.yaml`），TTL 驱动刷新，带异常标注。
- **提示词通道** — 系统提示词里的方法论段落 + 每步提醒，渐进披露：常驻只有几行核心，完整文档按需拉取。

## 包

| 包 | 角色 |
|---|---|
| `@elinpf/dsh-ops-access` | 凭证登记核心：`ctx.opsAccess` 服务、`access.yaml`、提供方注册帮手 |
| `@elinpf/dsh-ops-access-k8s` / `-ceph` / `-ssh` | 凭证提供方：zod schema、字段加工、保存时内容校验、能力探针 |
| `@elinpf/dsh-ops-access-gate` | 访问门：按会话代理、ro/rw 分层、授权、审批流、审计日志 |
| `@elinpf/dsh-ops-tool-kubectl` / `-tool-ceph` / `-tool-ssh` | 模型工具：按名字解析档案并拼命令 |
| `@elinpf/dsh-ops-shell-tool` | 共享消费方库（不是插件）：结果形状、输出 schema、执行模板、路径擦除 |
| `@elinpf/dsh-ops-tool-trace` | 调查树工具（`trace`）+ 树教义 |
| `@elinpf/dsh-ops-trace-ui` | 调查树 web 面板的 host 平面薄壳 + 共享 `trace` 会话投影 |
| `@elinpf/dsh-ops-tool-environment` | 环境清单：扫描核心 + `environment` 工具（overview/show/refresh） |
| `@elinpf/dsh-ops-panel` | 会话作用域对话框面板缝（`ctx.opsPanels`） |
| `@elinpf/dsh-ops-prompts` | 提示词通道：方法论段落、提醒、内置 prompt-only skills |
| `@elinpf/dsh-ops-access-ui` | `@` 档案引用选择器的浏览器半 |

[`ops-preset.yml`](ops-preset.yml) 是参考的 agent 平面组合（`ops` 预设），把这些包和上游 dsh 工具一起挂载。

## 架构要点

- **两个平面。** 模型可见行（工具、提示词内容）在 preset 平面；登记表、投影、web 客户端载体在 host 平面。一行只属于一个平面。
- **能力缝三角色。** 凭证体系拆成定义包（`ops-access` core）、提供方（每类一个）、消费方（工具）——提供方之间互不依赖。
- **模型可见 ⟺ 已记录。** 到达模型请求的任何东西都必须能从 session 事件日志重建；树状态由投影从事件 fold 出来。
- **密钥永不经过任何服务。** 档案携带路径而非密文。访问门的威胁模型是「防误操作，不防恶意」。

设计决策在 [`docs/adr/`](docs/adr/)，定稿 spec 在 [`docs/specs/`](docs/specs/)，领域词汇表在 [`CONTEXT.md`](CONTEXT.md)。

## 安装

按需安装包，并参照 [`ops-preset.yml`](ops-preset.yml) 接入你的 agent 预设——它给出了所需的 group、realm 和行 id：

```sh
npm install @elinpf/dsh-ops-access @elinpf/dsh-ops-access-k8s @elinpf/dsh-ops-access-ssh
```

本插件集面向 dsh 的 `dsh-v0.1.0-rc` 线和 `@deepseek-ai/cordis` v4。每个插件包自带 `cordis.patch.yml`（在 package.json 的 `dsh.bundle.patch` 里声明）；web 客户端半（`*-ui`、`ops-panel`）额外声明 `dsh.client.platform: "web"`。

## 开发

pnpm monorepo；日常命令按包执行：

```sh
pnpm install                # 仓库根，一次
cd packages/<pkg> && npm run build && npx vitest run
```

全仓扫描（CI 跑的）：根目录 `pnpm -r run build`、`pnpm -r run test`。

## 版本与发布

15 个包共享一个版本号（changesets `fixed` 组）一起发布。任何用户可见改动：跑 `pnpm changeset` 并提交生成的 `.changeset/*.md`；合并 master 上的 "chore: version packages" PR 后，GitHub Actions 将整套发布到 npm。

## 安全说明

- 密钥材料不进入任何服务、日志、错误信息或模型上下文——凭证文件在登记时写入一次，之后只按路径引用。
- 保存时校验（`validateContent`）在写入时拒绝畸形凭证，失败时零文件 IO。
- 访问门记录每次授权与收回的审计日志。同 UID 进程内保密显式超出范围。
