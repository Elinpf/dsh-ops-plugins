# @elinpf/dsh-ops-access-ui

`@`-提及 ops-access 凭证档案的浏览器半包：host 行仅为 client bundle 发现而存在；候选数据、admin 路由和 mention 展开都在 `@elinpf/dsh-ops-access`（preset 面）。

## 功能

产出 web client bundle（`dsh.client.platform: "web"`，esbuild → `lib/client.js`），在 dsh web 应用里注册五个面：

- **`access` @-mention 源**：候选来自 `GET /ops-access/list`；选中即插入现成的 `@[kind/name](dsh-access:...)` mention（codec 是恒等，展开由 ops-access core 的 preset 面监听器完成）。只有 rw 档的条目会带「ro 未注册（可由 rw 派生）」徽标。
- **`settings.section` 条目**（`ops-access-admin`，凭证管理）：ro/rw 合并的凭证列表（含逐档校验图标和探针徽标）、JSON-Schema 驱动的新增/编辑表单、带确认条的删除。
- **两个 ops-panel 页面**：`access`（访问授权：带 TTL 选择的批准/拒绝待决申请、授予/延长/收回本会话授权、封禁/解封）和 `access-all`（授权总览：跨会话同套操作）。
- **输入坞红点徽标**：待决 `request_access` 计数 —— 本会话部分直接读运行时快照（零轮询），委派子会话的申请每 4 秒轮询；点击打开审批面板。

所有数据走 `@elinpf/dsh-ops-access`（preset 面，贴着数据）提供的纯 HTTP 路由。路由 404（ops preset 未挂载）或网络失败时，每个面都优雅降级 —— 空列表、内联提示，绝不白屏。

## 设计要点

- **host 行是空的**：web 应用的 ClientModuleRegistry 靠扫描 HOST cordis 条目里的 `dsh.client` 发现 client bundle，所以包必须挂在 host 面；host 侧 `apply` 有意为空。
- **为什么路由不在这里**：从 host 面的外部包去够 preset 域的 `opsAccess` 服务会让 dsh 内部模块双实例（模块私有状态静默分叉）—— 按仓库惯例，跨面数据一律走 HTTP。
- **密钥不过线**：admin 路由只回信封和校验状态；凭证文件字段保存后只写不读。
- **注册纪律**：每个面都注册在 `ctx.effect`（或 inject 作用域的 effect）里，fiber 销毁/HMR 时随之卸载。测试会执行收集到的全部 disposer 并断言五个面全部消失；`injectCSS` 用 DOM 标记（而非模块级 flag）判重，HMR 重载不会重复插入 `<style>`。

## 配置项

无 —— `Config` 是 `z.object({})`。

## 测试方式

```sh
npm run build   # tsc → lib/（index/types/invariant）+ esbuild → lib/client.js
npx vitest run  # 导出形态、@ 源、settings.section、admin/panel API 函数、
                # 404/断网降级、徽标计数推导、HMR 卸载（全部 disposer 移除五个面）
```

## 已知限制

- 面板和输入坞徽标打开时轮询（3–4 秒），没有推送通道。
- 编辑表单看不到已存的凭证文件内容（保存后只写不读），textarea 用占位符说明。
- 面板仅在 ops-panel seam（`opsPanels`）被组合时注册；缺它时 @ 源和 settings 条目不受影响。
