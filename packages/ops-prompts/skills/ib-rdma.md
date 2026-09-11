---
name: ib-rdma
description: IB/RDMA/IPoIB fabric 排查方法论——逐口认 fabric、SM 定位与存活性判别、directed-route 绕 SM 爬拓扑、错误计数器、VL15/VL0 控制面与数据面分离的判别器思维
whenToUse: 排查 InfiniBand/RDMA/IPoIB 网络问题（链路抖动、SM 异常、fabric 拓扑残缺、挂载 stall 怀疑网络层）时；主机上有 ibstat/sminfo/ibnetdiscover 等 infiniband-diags 工具时
---

# IB/RDMA fabric 排查

IB 排查最容易犯的两个错误：**以为一台机器只属于一张 fabric**、**以为 SM 不可达就是网络中断**。本 skill 的全部内容都是为了不犯这两个错误。所有命令只读；任何改配置、重启服务、ifup/ifdown 都不属于排查动作。

## 第 0 步：先认清楚这台机器有几张 fabric

```
ibstat                    # 全端口清单：几张 HCA、每个口的速率/状态/物理状态
```

一台 GPU 机器很常见地同时属于多张**互不相通**的 fabric（如 400G 计算 fabric + 存储 IPoIB fabric）。而所有 IB 工具**默认只走第一个可用口**——不逐口查，整张 fabric 对你不可见（真实教训：Fabric B 全程缺席排查，因为 ibnetdiscover 只爬了默认口所在的 Fabric A）。

所以后面每条命令都要养成 `-C <device>` 逐口打的习惯：

```
ibstat | grep -E '^(CA|Port )'     # 列出所有 CA:port
sminfo -C mlx5_0 ; sminfo -C mlx5_8 ...   # 每个口各问一遍
```

## SM 定位与存活性

```
sminfo -C <dev>           # SM 的 GUID、优先级、MASTER/standby、activity count
ibswitches -C <dev>       # 交换机清单：几台、型号、固件
ibhosts -C <dev>          # 主机清单
```

- 把 sminfo 的 smGUID 对照 ibswitches/ibhosts 的 GUID，判断 SM 是**交换机内嵌**、**主机 opensm**，还是 **UFM**。单 SM = 单点故障候选。
- **SM 活着的硬证据是 activity count 持续增长**，隔 10 秒跑两次 sminfo 对比。"能应答"不如"在增长"。
- 疑似 SM flap：`sminfo` 轮询 + `journalctl -u opensm` / dmesg 取证死亡窗口。

## SM 不可达 ≠ 网络黑洞（最重要的判别）

SM/SA 只管控制面（MAD 查询、LID 分配）。**已有数据流不经过 SM**。判别顺序：

1. `smpquery`/`saquery` 超时或空 = 控制面失联（SM/SA 层面）。
2. 数据面是否真断，用与 SM 无关的证据：`/sys/class/net/<ibif>/statistics/rx_bytes,tx_bytes` 间隔采样看流量是否还在走；正在进行的 RDMA 吞吐（如 ceph/k8s 监控曲线）是否归零。
3. 只有数据面也归零，才能说"中断"。控制面死亡 + 数据面正常 = SM 事件，不是链路事件。

同理，VL 分离也是判别器：MAD 走 VL15，数据走 VL0——"VL15 不通但 VL0 有流量"指向控制面，"两者同时归零"才是链路/硬件。

## SM 死了怎么继续查拓扑：directed-route

`ibnetdiscover` 正常模式依赖 SM；SM 不可达时用 directed-route 直接爬（不依赖 SM）：

```
ibnetdiscover -C <dev>           # 先正常试；不行就用 directed-route 模式
ibtracert <src-lid> <dst-lid>    # 两个端点间的物理路径与跳数（同 leaf 1 跳 vs 跨 leaf 3 跳）
```

读拓扑时算一下账：交换机数 × 端口数 vs 主机数 × 每机端口数。端口"全部占满但看不到某批节点"= 要么存在你看不到的第二张 fabric（回到第 0 步逐口查），要么 ISL 断裂（fabric 分裂）。

## 错误与 flap 计数器

```
ibqueryerrors -C <dev>           # symbol errors / link downed / credit stall，按端口列出
```

- symbol errors 持续增长 = 物理层（线缆/光模块）问题。
- LinkDowned 高 = 链路 flap 史。
- 以太网侧对应物：`cat /sys/class/net/<if>/carrier_changes`——**用计数器证伪 flap 假设**，一次都没变过就是没有 flap（真实教训：一个"对端 flap"假设被自开机以来恒为 0 的 carrier_changes 直接处决）。

## 纪律

- 每条假设配一个**判别命令**："如果 H 成立，X 命令应该看到 A；不成立会看到 B"——先想判别器再动手。
- 控制面工具（smpquery/saquery）失败只证明控制面，不要外推数据面。
- 所有结论标注证据强度：计数器/协议应答（强）、日志旁证（中）、时序吻合（弱）。
- 本 skill 只有只读命令；修复（重启 opensm、ifup、改 SM 优先级）走 /change 流程。
