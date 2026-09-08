---
"@elinpf/dsh-ops-access": minor
"@elinpf/dsh-ops-access-ssh": minor
"@elinpf/dsh-ops-tool-ssh": minor
---

SSH 凭证与主机分离：新增 `ssh-cred` 凭证种类（密钥或密码登记一次、多台主机经 `cred` 引用共享，轮换只改一处）;core 增加通用引用机制（provider 声明 `references`,resolve 时把被引用条目字段合并到引用方之下，broker 只对引用方咨询一次）与 `validateResolved` 合并后校验钩子；ssh 工具支持密码登录（`sshpass -f`，密码型档案关闭 BatchMode),dsh 宿主机需安装 sshpass。主机条目内联 `key` 的旧写法继续可用。详见 ADR-0007。
