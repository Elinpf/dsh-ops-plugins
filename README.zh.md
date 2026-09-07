# dsh-ops-plugins

[English](README.md) | 中文

面向运维场景的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件集：把 dsh agent 变成生产事件排查员——按名字解析 kubectl / ceph / ssh 凭证、对集群执行只读命令、把排查过程组织成树。

以单个 npm 包 `@elinpf/dsh-ops` 安装，颗粒化的 `@elinpf/dsh-ops-*` 包作为依赖整体带入，锁步版本发布。

## 特性

- 凭证只登记路径，agent 只见档案名——密钥不进入模型上下文
- 默认只读；读写需按会话授权、人工审批，全程留审计日志
- 工具输出真实，敏感路径在到达模型前擦除
- `trace` 工具把排查组织成树，web UI 以 git-graph 风格渲染
- 环境清单扫描，agent 基于「实际存在什么」推理
- 系统提示词只注入几行方法论，完整文档按需拉取

## 环境要求

- DeepSeek Harness ≥ 0.1.0-rc（已在 0.1.0-rc、0.1.1-rc.2 验证）
- pnpm ≥ 10
- 宿主机上有 `kubectl` 且集群网络可达；`ceph` / `ssh` 按需

## 安装

1. 安装插件包（依赖与宿主层行自动挂载）：

   ```sh
   dsh plugin --profile ops add @elinpf/dsh-ops
   ```

2. 需要 web UI 时，编辑 `~/.dsh/profiles/ops/package.json`，把 web 宿主加进 bundles：

   ```json
   "dsh": {
     "profile": {
       "bundles": [
         "@deepseek-ai/dsh-base",
         "@deepseek-ai/dsh-web-app",
         "@elinpf/dsh-ops"
       ]
     }
   }
   ```

   `@deepseek-ai/dsh-web-app` 随 dsh 安装解析，不能用 `dsh plugin add` 安装。

安装报 `minimumReleaseAge` 错误时，在 profile 的 `pnpm-workspace.yaml` 加排除项（版本与当前一致）：

```yaml
minimumReleaseAgeExclude:
  - '@elinpf/*@0.1.5'
```

## 部署

1. 落盘 ops 预设：

   ```sh
   npx @elinpf/dsh-ops preset install --agents-home ~/.dsh
   ```

   harness 从 `~/.dsh/.agent-presets/` 发现用户预设；不带 `--agents-home` 会装到 `~/.agents`，静默失效。

2. 编辑 `~/.dsh/profiles/ops/cordis.patch.yml`，把顶层数组改为：

   ```yaml
   - id: agent-presets
     config:
       default: ops
   - id: session-reference
     disabled: true
   ```

3. 启动（`--no-open` 不自动开浏览器；参数同 `dsh web`）：

   ```sh
   dsh --profile ops --no-open
   ```

4. 登记凭证到 `~/.dsh-ops/access.yaml`——只存路径和连接参数，不存密钥。`list_access` 带 `help: true` 可拉取格式文档，也可用 web 管理界面登记。

验证：

```sh
dsh --profile ops --dump-config | grep -A4 'id: agent-presets'      # default 应为 ops
dsh --profile ops --dump-config | grep -A2 'id: session-reference'  # 应带 disabled: true
```

然后 web UI 开一个 ops 会话：`list_access` 列出档案、`kubectl` 正确解析、trace 面板渲染、rw 凭证触发审批。

## 集中凭证平台 access-hub（可选）

默认凭证存在 dsh 宿主机的本地 YAML 注册表里。需要集中管理——一处登记、轮换、审计——可以跑 `@elinpf/dsh-ops-access-hub`：一个独立部署的服务（不是 dsh 插件），全部凭证存于单一 AES-256-GCM 加密文档，对外提供 token 认证的小型 HTTP API 和内置 Web 界面。

1. 启动 hub：

   ```sh
   npx @elinpf/dsh-ops-access-hub serve
   ```

   参数（flag / 环境变量 / 默认）：`--port` / `ACCESS_HUB_PORT` / `3090`；`--host` / `ACCESS_HUB_HOST` / `127.0.0.1`；`--data-dir` / `ACCESS_HUB_DATA_DIR` / `~/.dsh-ops-hub`；`--key-file` / `ACCESS_HUB_KEY_FILE` / `<data-dir>/hub.key`；`--admin-token` / `ACCESS_HUB_ADMIN_TOKEN` 与 `--read-token` / `ACCESS_HUB_READ_TOKEN` / 未配置时首启生成并打印一次。master key 来自 `ACCESS_HUB_KEY`（base64/hex）或 key 文件（自动生成，0600）。

2. 把现有 YAML 注册表迁入 hub（路径形态的字段值会替换为文件内容）：

   ```sh
   npx @elinpf/dsh-ops-access-hub import ~/.dsh-ops/access.yaml \
     --url http://127.0.0.1:3090 --admin-token <admin token>
   ```

   离线方式：用 `--data-dir <dir>` 替代 `--url`，直接写 hub 的数据文件。

3. 在 `~/.dsh/profiles/ops/cordis.patch.yml` 加一行配置，把 ops-access 指向 hub：

   ```yaml
   - id: ops-access
     config:
       source: hub
       hubUrl: http://127.0.0.1:3090
       hubToken: <read token>          # 或用环境变量 ACCESS_HUB_READ_TOKEN
       hubAdminToken: <admin token>    # 或用环境变量 ACCESS_HUB_ADMIN_TOKEN
   ```

   改完重启 profile。文件字段内容在 resolve 时按需从 hub 拉取并物化到 `~/.dsh-ops/credentials` 下的本地文件（0600）；profile 仍只携路径，访问门、能力探针、管理 UI、各工具的行为与 YAML 模式完全一致。

安全提示：v1 是明文 HTTP——保持默认的 loopback 绑定，或把 hub 放在 TLS 反向代理之后。hub 是单点：数据文件和 master key 都要备份。本地 YAML 模式随时可切回作为回退。

## 交给 Agent 安装

在任意 dsh 会话里把下面这段发给 agent，让它替你完成安装与部署：

```text
阅读 https://github.com/Elinpf/dsh-ops-plugins 的 README.zh.md，
把 @elinpf/dsh-ops 插件集安装部署到 ops profile，
完成后按 README 里的验证步骤确认。
```

## 更新

```sh
dsh plugin --profile ops add @elinpf/dsh-ops@latest
npx @elinpf/dsh-ops@latest preset install --agents-home ~/.dsh   # 预设是落盘文件，必须重新拷
dsh --profile ops --no-open                                       # 重启
```

用 `add @latest` 而不是 `update`——`update` 不跨 minor。预设不随包更新自动刷新，必须重新落盘。

## 卸载

1. 移除预设：

   ```sh
   npx @elinpf/dsh-ops preset remove --agents-home ~/.dsh
   ```

2. 移除插件包：

   ```sh
   dsh plugin --profile ops remove @elinpf/dsh-ops
   ```

3. 重启 profile：

   ```sh
   dsh --profile ops --no-open
   ```

4. 按需删除 `~/.dsh-ops/`——凭证登记表、环境清单、被引用的凭证文件。

卸载不影响集群：凭证只是对自有文件的只读引用。

## 安全

- 密钥不进入服务、日志、错误信息或模型上下文
- 访问门的威胁模型是「防误操作，不防恶意」
- 设计决策见 [`docs/adr/`](docs/adr/)；领域词汇表见 [`CONTEXT.md`](CONTEXT.md)
