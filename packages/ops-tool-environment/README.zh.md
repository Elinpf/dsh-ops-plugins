# @deepseek-ai/dsh-ops-tool-environment

DeepSeek Harness 运维模式的环境清单 —— 只读、纯确定性的盘点器：遍历 `ops-access` 注册的 k8s 集群，盘出环境地图落盘为 `~/.dsh-ops/environment.yaml`；agent 经模型工具 `environment` 消费（spec 见 `docs/specs/0003-environment-inventory.md`）。

## environment 工具

四个动作：`overview`（各集群摘要：中间件分类计数、unknown 数、stale 标记、盘点时间）、`show`（单集群详情：中间件实例、unknown 桶、关联边）、`refresh`（立即重扫全部注册的 k8s 集群）、`help`（完整用法——渐进披露，系统提示词只放一句引导）。

- **新鲜度** —— 清单缺失或最老段超 TTL（`ttlMinutes`，默认 60 分钟）时读操作先自动重扫；会话启动绝不扫描
- **只读凭证** —— refresh 解析 k8s 档案不带 agent 身份，审计门 broker 无 agent 时回落 ro 档
- **两行挂载** —— realm 拓扑拆分：工具入口（`.`）在 `ops-access-registry` 组（要 `opsAccess`），`./prompt` 子路径插件经 `ops-prompts` 注册那句提示词、挂在 `ops-orchestration` 组。entry-local isolate realm 跨组不可见，一行拿不到两个服务

## 做什么

对每个注册的 k8s 集群，经 `kubectl` 拉取工作负载（deploy/sts/ds）、Service、Ingress、ConfigMap 和 Secret **元数据**，按分类表识别中间件实例，尽力而为连关联边，按集群分段落盘并带盘点时间戳。

- **确定性** —— 同一集群扫两次字节一致，零 LLM
- **新鲜度** —— 每段带 `scannedAt`；刷新失败保留旧段并标 `stale: true`
- **unknown 桶** —— 识别不出的工作负载照常列出名称与镜像
- **Prometheus 印证** —— 集群里有可发现的 Prometheus service（名字含 `prometheus`、带 9090 端口、`monitoring` 命名空间优先）时，经短生命周期 `kubectl port-forward` 读 `/api/v1/targets`，给工作负载附 `monitoring: { up, down }`。此增强任何失败都静默降级——清单段照常写入，不标 stale
- **用户规则** —— `~/.dsh-ops/environment-rules.yaml` 可追加/覆盖分类规则

## 安全纪律

- Secret 只取 metadata（jsonpath 只选 namespace/name），`data` 不进进程
- kubeconfig 路径在进入清单/日志/模型上下文前一律擦除为 `<kubeconfig>`
- 容器 env 只读明文字面值；`valueFrom` 只记引用名

## 模块划分

| 模块 | 职责 |
|---|---|
| `src/scanner.ts` | kubectl 读取 → `ClusterScan`（纯数据，exec 可注入，30s 超时） |
| `src/classify.ts` | 镜像/chart/label → 中间件类型；内置表 + 用户规则文件 |
| `src/relations.ts` | 关联边：`uses-service`、`fronts`、`uses-middleware`、`references-secret` |
| `src/prometheus.ts` | Prometheus 印证：service 发现、`kubectl port-forward` 生命周期（必然回收）、targets 解析、工作负载匹配 |
| `src/inventory.ts` | `environment.yaml` 落盘、读接口、refresh + stale 逻辑 |
| `src/tool.ts` | `environment` 工具工厂（动作、TTL 门、render）；`createEnvironmentTool` 依赖可注入便于测试 |
| `src/doctrine.ts` | 工具描述、一句提示词、help 全文的唯一事实源 |
| `src/prompt.ts` | `./prompt` 子路径插件：经 `ops-prompts` 注册提示词 |
| `src/index.ts` | 工具插件入口（name/inject/Config/apply）+ 盘点器核心 re-export |

## 开发

```sh
npm run build    # tsc → lib/
npm test         # vitest
```
