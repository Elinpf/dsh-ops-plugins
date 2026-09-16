# @elinpf/dsh-ops-access-ssh

## 0.4.0

### Patch Changes

- 34bc97e: 内部去重清理(code-review 坏味项,无行为变化):expandHome 归位 core/backend.ts(消除 hub-backend 重复实现);单行粘贴守卫提取为 core 导出的 hasSingleLineBody(ssh/prometheus 两 provider 共用);ops-shell-tool 导出 shellToolOutput 契约,ops-tool-prometheus 复用替代逐字拷贝;hub-backend.listRequests 去掉从未使用的 status 参数;access-ui badge 的 pendingRequestCount 内联。另新增私有 test-support 包,合并三份逐字相同的 tests/tmpdir.ts。
- Updated dependencies [5d1a604]
- Updated dependencies [34bc97e]
  - @elinpf/dsh-ops-access@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [8583b23]
  - @elinpf/dsh-ops-access@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [4d28c14]
  - @elinpf/dsh-ops-access@0.2.1

## 0.2.0

### Minor Changes

- 401a8a7: SSH 凭证与主机分离：新增 `ssh-cred` 凭证种类（密钥或密码登记一次、多台主机经 `cred` 引用共享，轮换只改一处）;core 增加通用引用机制（provider 声明 `references`,resolve 时把被引用条目字段合并到引用方之下，broker 只对引用方咨询一次）与 `validateResolved` 合并后校验钩子；ssh 工具支持密码登录（`sshpass -f`，密码型档案关闭 BatchMode),dsh 宿主机需安装 sshpass。主机条目内联 `key` 的旧写法继续可用。详见 ADR-0007。

### Patch Changes

- Updated dependencies [67c6abe]
- Updated dependencies [b8bb955]
- Updated dependencies [bf99896]
- Updated dependencies [401a8a7]
  - @elinpf/dsh-ops-access@0.2.0

## 0.1.7

### Patch Changes

- @elinpf/dsh-ops-access@0.1.7

## 0.1.6

### Patch Changes

- @elinpf/dsh-ops-access@0.1.6

## 0.1.5

### Patch Changes

- @elinpf/dsh-ops-access@0.1.5

## 0.1.4

### Patch Changes

- @elinpf/dsh-ops-access@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [e6aa27b]
  - @elinpf/dsh-ops-access@0.1.3

## 0.1.2

### Patch Changes

- @elinpf/dsh-ops-access@0.1.2

## 0.1.1

### Patch Changes

- @elinpf/dsh-ops-access@0.1.1
