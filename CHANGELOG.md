# Changelog

本项目的所有重要变更均记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.5.0] - 2026-08-31

### Added

- **footer**：新增 GLM coding plan 7 天配额窗口（`⏳7d 92% ███████████████████░ ↻3d`）显示，与 5h 窗口（`⏳5h`）作为两个独立仪表盘并列展示——5h 是滚动节流阀（mdLink 蓝基线），7 天是全周硬上限（thinkingHigh 紫灰基线），共用同一套告警阈值（≥70% 黄、≥90% 红），同一快照同时转暗、各自倒计时 dim；数据来自同一次 bigmodel.cn 配额接口轮询（`unit: 3` + `unit: 6` 双窗口一次解析），`footer-preview` 镜像同步更新；决策记录见 `docs/adr/0001-footer-dual-quota-windows.md`

### Changed

- **docs**：CONTEXT.md 术语表更新——5h 窗口定义改为「随消耗滚动刷新的节流窗口」，新增「7 天窗口」词条（全周硬上限，以 ⏳7d 展示），不再用「周窗口」指称

## [0.4.3] - 2026-08-30

### Fixed

- **warp-notify**：修复外层 run 结束但后台子代理仍在运行时提前发 `stop` toast 的问题——stop payload 被持有（`deferredStop`），待最后一个 run 结束（`agent_end` 或 `session_shutdown` 过零）时 flush，且 flush 报告的是**外层** run 的问答快照而非最后一个子代理的内部文本，Warp 徽标不再在 spinner 仍在转时先翻成"完成"。子代理会话改为显式识别：`session_start`（reason startup）在 run 进行中到达即标记为 child（`subagentSessions`，pi-subagents 在提示前绑定扩展），child 只递增计数、永不 capture prompt、不接管 outer 角色，其结束也因此无法错误结算 outer；settled 状态下 child 的 `agent_start` 不再误触发新 outer 接管。`tool_complete` 后无条件恢复心跳。

### Added

- **test**：新增 warp-notify 状态机测试（bun test，7 组用例覆盖 stop 持有/flush、子代理不接管、接管重报、过零 flush、阻塞问答），`package.json` 增加 `test` 脚本并纳入 Done 标准。

## [0.4.2] - 2026-08-30

### Fixed

- **warp-notify**：修复子代理（Agent 工具）会话销毁时 `session_shutdown` 无条件调用 `cleanupAll()` 清空共享状态的问题——主会话 run 仍在执行但动画已被停掉且无 `agent_start` 可重启，tab 标题静止、心跳中断、`runCtx` 悬空导致后续 stop toast 丢失。现按会话记账（`runsBySession`）：子会话销毁只释放自己的份额，其它 run 存活时共享状态原封不动；阻塞调用条目携带 `sessionId` 随死会话排干；被销毁会话持有 outer 角色时交还角色而非清零。

## [0.4.1] - 2026-08-30

### Fixed

- **footer**：coding plan 条 5 格 → 20 格（每格 5%）且填充改用 `Math.ceil`——低占比（如 8%）按 `Math.round` 会归零，整条全空看不出进度；上下文条 10 格 → 20 格对齐；`footer-preview` 镜像同步并新增 8% 预览用例

## [0.4.0] - 2026-08-30

### Fixed

- **warp-notify**：修复 OSC 777 的 title 位误写为 agent id（`pi`）——Warp 只在 title 位为 `warp://cli-agent` URI 时才把 body 解析为结构化 cli-agent 事件，否则退化为通用 toast 直接显示原始 JSON（启动后首条通知即是一坨未解析的 payload）

### Changed

- **warp-notify**：按上游 rpiv-warp 的文件结构拆分为子目录 `extensions/warp-notify/`（`protocol.ts` 探测/协议协商、`payload.ts` 载荷组装、`warp-notify.ts` OSC 传输、`title-spinner.ts` 标题动画、`config.ts` 可调参数、`index.ts` 注册 + 状态机），除 refcount 状态机（SubAgent spinner 修复）外与上游逐文件对齐

- **docs**：README 精简为纯用户视角，删除网关适配表、实现机制与内部参数；AGENTS.md 改为 Pointers 结构，收录 SNAPSHOT 维护指引

### Added

- **warp-notify**：新增 Warp 终端通知扩展（移植自 `@juicesharp/rpiv-warp`，MIT）。仅在 Warp 内激活：监听 pi 生命周期事件（session_start / agent_start / tool_call / tool_execution_end / agent_end），向 `/dev/tty` 写 OSC 777 结构化事件驱动系统通知与 tab 徽标；turn 进行中以 160ms 盲文帧重写 OSC 0 标题实现转点动画（标题栈 push/pop 保证还原），15s 心跳重报避免 Warp 把 tab 标记为空闲；`ask_user_question` 等阻塞工具触发 Blocked 徽标，ESC 中断时在结算点补发 tool_complete 清理残留徽标；含坏版本 gate（≤ v0.2026.3.25.8.24 stable/preview 广播协议但不渲染）与协议版本协商。状态机以 in-flight 计数 + 可结算外层（`activeRuns`/`blockedCalls`/`outerSettled`）替代上游的布尔开关：SubAgent 会话共享同一模块实例（ESM 缓存），上游子代理的 agent_end 会关掉父会话的动画并发出假 stop/idle toast；此实现下嵌套子代理只递增计数、动画持续到最外层 run 结束，后台子代理（run_in_background）晚于父结束时由可结算外层接管（新外层重新 announce 并接管心跳，最后一个非外层 run 结束只停动画不重发 stop），并发 run 天然组合。已用伪终端捕获转义字节验证（子代理结束前后 spinner 连续 tick、事件序列与 payload 正确）。

## [0.3.0] - 2026-08-29

### Added

- **footer**：新增 GLM coding plan（`zai-coding-cn`）5 小时配额窗口显示（`⏳5h 42% ██░░░ ↻2h15m`）：蓝色（mdLink）5 格进度条与绿色上下文条区分，≥70% 黄、≥90% 红，重置倒计时 dim；数据来自 bigmodel.cn 配额接口（响应结构已实测核对），凭据经 `modelRegistry.getApiKeyForProvider` 解析，仅在该 provider 活跃时显示；5 分钟轮询 + 渲染时惰性刷新，超 10 分钟的快照整段转暗，窄终端下先于模型 id 截断

### Fixed

- **footer-preview**：修复 `isAbsolute` 未导入导致脚本在 `$HOME` 内目录必然崩溃的问题

## [0.2.0] - 2026-08-25

### Added

- **system-prompt**：注入 git 无交互约定（`GIT_EDITOR=true`、`--ff-only`、`--no-edit`）

## [0.1.0] - 2025-06-25

### Added

- **provider**：支持 `/login` 存储 CodeBuddy API key 认证
- **footer**：新增自定义状态栏扩展，显示工作目录、思考等级，并响应切换事件
- **system-prompt**：注入 rg 搜索偏好到系统提示词

### Changed

- **footer**：默认启用，并根据有效窗口动态计算颜色阈值
- **provider**：移除环境变量 key 回退与 kimi/minimax 旧版模型
- **structure**：扩展聚合为单一 `index.ts` 入口，系统提示词注入拆分为独立扩展文件
- **package**：重命名为 `pi-codebuddy-kit`

### Docs

- **readme**：简化 README，移除环境变量配置方式，同步模型目录与网关兼容性实测
