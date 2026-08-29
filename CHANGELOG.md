# Changelog

本项目的所有重要变更均记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-08-30

### Changed

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
