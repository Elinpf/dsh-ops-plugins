# 0003 — 环境清单 (Environment Inventory)

## 问题陈述

运维场景纳管的中间件种类繁多（nacos、sentinel、seata、redis、elasticsearch、kafka、mysql、clickhouse、minio、milvus、elk、mqtt、oss、mongodb、s3……)，分布在多个环境的多套 k8s 集群上。一一为每种中间件做适配不现实也无法管理。运维 agent 目前对环境一无所知：不知道东西在哪、谁连谁，每次排查都要从零摸索。资源变动后也没有手段让 agent 的认知跟上。

核心目标：**让 agent 认识我们的环境**——迅速知道这些内容在哪里、关联关系是什么，并且资源变动后认知能自动跟上。

## 解决方案

一个只读的环境盘点能力。遍历 `ops-access` 里注册的 k8s 集群，从 k8s API 盘出环境地图（集群 → 命名空间 → 中间件实例/应用 → 尽力而为的关联边 + Prometheus 监控状态），落成清单文件；agent 通过新的 `environment` 工具消费（overview / show / refresh)。

关键约束：**扫描是纯确定性代码，LLM 只消费清单做推理**——同样的集群扫两次结果必须一模一样，这是清单能当"地图"用的前提。

### 已验证的落地依据（pf-test-cluster 实测）

- 中间件实例可从 sts/deploy 的镜像名/chart/label 分类；自家应用无 label 但镜像名自描述
- 关联链条"应用 → envFrom → ConfigMap → `*.svc.cluster.local` 地址 → Service → 实例"全程在 k8s API 可见，不需要进容器、不需要读应用代码
- k8s 之外的资源有信号可抓：ExternalName Service、无 selector 的 Service(endpoints 指向外部 IP)
- 现有手工维护的 `clusters.json`(db-collector-config）正是要自动化掉的东西

## 用户故事

1. 作为运维人员，我希望 agent 在排查前就知道环境里有哪些集群、每个集群上跑着什么中间件，这样我不必在对话里手工交代拓扑。
2. 作为运维人员，我希望知道某个应用连的是哪个数据库/缓存/消息队列，这样定位故障影响面时不用挨个翻配置。
3. 作为运维人员，我希望清单条目上能看到 Prometheus 的监控状态（up/down)，这样 agent 能先发现"这个实例在监控里已经是 down 的"。
4. 作为运维人员，我希望环境变动后清单自动跟上（过期重扫），也能让 agent 随时显式刷新，这样我信任看到的图是准的。
5. 作为运维人员，我希望识别不出的工作负载也被列出（unknown 桶），这样新引入的中间件不会从视野里消失。
6. 作为运维人员，我希望内置分类表之外能用自己的规则文件追加识别规则，这样公司内部的私有组件也能被分类。
7. 作为运维人员，我希望某个集群暂时连不上时清单仍可用（保留旧数据并标记 stale)，而不是整块缺失或报错。
8. 作为安全负责人，我希望盘点过程绝不读取 Secret 的值，这样凭证材料不会进清单、日志和模型上下文。

## 实现决策

- **范围**:纯只读。不主动修资源、不主动加监控点位（agent 管理监控记为后续方向，单独立项）。不碰审计门 rw 授权。
- **集群来源**：遍历 ops-access 注册表里的 k8s 档案（ro 档即可），清单的集群覆盖面 = 注册的集群。
- **扫描是确定性代码**:kubectl/API list + 分类表归类 + 写 YAML。零 LLM 参与。
- **识别**：分类表内置代码，覆盖常见中间件（nacos、sentinel、seata、redis、elasticsearch、kafka、mysql、clickhouse、minio、milvus、mqtt、mongodb、postgres、prometheus 等）；匹配镜像名/chart 名/label。识别不出进 **unknown 桶**，照常列出名称与镜像。用户规则文件（`~/.dsh-ops/` 下）可追加/覆盖规则。
- **关联深度**：尽力而为。粗粒度地图（应用 ↔ 集群 ↔ 中间件）必须准；细粒度关联通过解析 ConfigMap 与明文 env 的值连边（识别 `*.svc.cluster.local` 等模式）,**Secret 只记引用名、绝不读值**（守住"秘密不过服务"底线）。更深的下钻交给排查时的 kubectl 工具现场做。
- **Prometheus 只读增强**：盘点时尝试发现集群内 monitoring 命名空间的 Prometheus service，经 kubeconfig 走 `kubectl port-forward` 读 targets API，把 up/down 状态附到清单条目上；找不到则跳过该集群的监控增强，不影响主清单。
- **新鲜度**:TTL（默认 1 小时）过期自动重扫 + `environment` 工具的 `refresh` 动作显式重扫；会话启动不阻塞，读缓存。集群连不上时保留旧数据、标记 stale。
- **清单存储**:`~/.dsh-ops/environment.yaml`，自动生成（头部标注"自动生成勿手改")，按集群分段，记录每段的盘点时间戳。
- **消费方式**：新 preset 平面工具 `environment`,action = overview（全貌摘要）/ show（某集群或某中间件详情）/ refresh（重扫）。系统提示词经 ops-prompts 只放一句引导（"排查前先 environment overview")，完整用法由工具 help 渐进披露。
- **包归属**：新包 `ops-tool-environment`(preset 平面）。复用 ops-access 的 k8s 凭证解析与 ops-shell-tool 的执行机器。

## 测试决策

- 只测外部行为：工具输出的清单形状、TTL/refresh 语义、stale 标记、unknown 桶、Secret 不落值。
- 扫描器核心（分类、关联解析）用录制的 k8s API 响应做纯函数单测；工具层走现有 ops-shell-tool 测试模式。
- 真实验证在 `.dsh-explore` 实例（3083）跑真实 session：overview 输出、refresh 后变动反映、Prometheus 状态附加。

## 范围之外

- agent 主动修复资源（走审计门 rw)——后续单独立项
- agent 主动加 Prometheus 监控点位/告警规则——后续单独立项
- 凭证真实权限探针（k8s `auth can-i` 核验 ro/rw 档）——已在 spec 0001 后续方向中记录
- 非 k8s 承载资源的手工登记——本期明确不做人工录入

## 备注

- 盘点器访问 Prometheus 依赖集群内存在可发现的 prometheus service；这是增强项而非硬依赖。
- 中间件的原生协议访问（mysql client、redis-cli 等）不在本期——排查时经 `kubectl exec`/`port-forward` + 中间件自带 CLI 进行，真有高频需求再单独补。
