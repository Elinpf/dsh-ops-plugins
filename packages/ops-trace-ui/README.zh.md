# @elinpf/dsh-ops-trace-ui

ops trace 功能的 host 面薄壳 — 注册共享的 `trace` session projection,并携带 web 面板 client bundle(输入框上方的调查树面板)。

## 功能

一个薄壳,两个 half:

- **Host 半**(`src/index.ts`):把共享的 `trace` projection 注册进 `ctx.sessionProjections`,通过 `ctx.inject` 延迟执行,loader 不会因此把本行与 registry 排序。projection 定义从 `@elinpf/dsh-ops-tool-trace` **原样引用**(引用同一对象,不是复制),因此 key/schema/fold/stateVersion 在工具半和面板半之间永不漂移。
- **Client 半**(`src/client.ts`,esbuild 打包为 `lib/client.js`):注册一个 `conversation.input.dock` 条目(`id: 'ops-tree'`),渲染可折叠的调查树面板,结构上与 todo_write 的 TodoPanel 完全一致。通过 `useProjection` 读 `trace` projection;registry 缺席时降级为不渲染。

不注册任何工具和 prompt section — `trace` 工具及其方法论在 `@elinpf/dsh-ops-tool-trace`,挂在 preset 面。

## 设计要点

- **为什么单独成包**:trace 功能按 plane 拆分。工具在 preset 面(面向模型);projection 注册表和 web client 载体在 host 面。本包就是 host 面的挂载点 — ops preset 组合它,面板才能到达浏览器。
- **client 发现是运行时的**:web app 的 ClientModuleRegistry 扫描组合后的 host cordis 条目,因此本包必须通过 `cordis.patch.yml` 行保持 host 面挂载,否则面板永远到不了浏览器。
- **共享布局**:兄弟排序、深度、DFS 扁平化来自 `ops-tool-trace/tree-layout` — 人看到的布局与模型看到的一致。
- **按会话的 UI 状态**:dock 在切换会话时卸载,React state 随之重置;折叠/选择状态放在以会话为键的模块级 map(`./types` 的 `DockUiState`)里,卸载后仍然保留。

## 配置

```yaml
- id: ops-trace-ui
  name: '@elinpf/dsh-ops-trace-ui'
```

无配置项 — `Config` 是空的 schemastery object。

## 测试

```sh
npm run build   # tsc → lib/,然后 esbuild → lib/client.js
npx vitest run
```

单元测试覆盖:两个入口的导出形态(函数插件形式、无 default 导出)、projection 的原样注册、通过注册定义驱动的 fold 行为、dock slot 注册,以及 HMR 卸载 — 执行全部 fiber disposer 后,projection 和 dock 条目都被移除。
