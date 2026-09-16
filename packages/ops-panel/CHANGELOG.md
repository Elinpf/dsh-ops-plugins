# @elinpf/dsh-ops-panel

## 0.4.0

## 0.3.0

## 0.2.1

### Patch Changes

- 4d28c14: 修复 0.2.0 发布物缺文件:`files` 白名单漏掉了 access-hub 新增的 `lib/backend.js`/`lib/hub-backend.js`(导致 npm 安装下 ops preset 挂载失败、所有 ops-access 路由 404)和 access-ui 的 `lib/candidates.js`(@ access 候选模块缺失、客户端插件加载失败)。ops-panel 顺带补上 `lib/types.js`。四个包的 `files` 统一改为 `lib/**/*.js` + `lib/**/*.d.ts` 通配,并新增 `scripts/check-pack-files.mjs` 打包覆盖检查接入 CI,防再犯。

## 0.2.0

## 0.1.7

## 0.1.6

## 0.1.5

## 0.1.4

## 0.1.3

## 0.1.2

## 0.1.1
