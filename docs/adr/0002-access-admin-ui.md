# ADR-0002: core 从只读变读写 —— 凭证管理 UI 的写入能力

core（ops-access/core）拥有两个凭证文件（access.yaml + access-rw.yaml），此前只读：现读现校验、不缓存。凭证管理 UI 需要浏览器侧录入/删除条目，写入必须有一个后端。决策：写入归 core——core 是两个文件的唯一管理者（ADR-0001 决策 6），写入复用现有 loadRegistry/buildProfile 的 parse + validate 机器，不手写第二份 YAML 逻辑。写入路由在 preset 平面注册（和现有 GET /ops-access/list 同位置），避免跨 plane 访问带状态服务的双模块实例问题。

被否决的替代：UI 包自己 fs 读写文件——违反"双文件归 core"的纪律，且 UI 包是 host 平面薄壳（apply 为空），让它碰凭证文件是职责越界。门来管写入——违反"门只做决策、不碰凭证"（ADR-0001 决策 6 的核心）。

安全纪律不变：只写不回读（表单不回填旧 fields，保存后回 envelope 视图，rw fields 永不流向浏览器）；列表 API envelope-only（kind/name/description/environment + 验证状态，不含 fields）；错误信息来自 zod 校验输出，不含密钥内容。