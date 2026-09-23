# Changelog

本项目的所有重要变更均记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.13.0] - 2026-09-23

### Changed

- **coding-plan**：footer 配额窗口不再展示 OpenCode Go 的 30 天窗口（`⏳30d`）——monthly 是最松的一档、日常几乎不构成约束，只保留 `⏳5h` + `⏳7d`；usage 端点返回的 `monthly` 字段直接忽略，术语表相应移除「30 天窗口」词条

## [0.12.0] - 2026-09-23

### Added

- **coding-plan**：新增独立扩展，拥有 coding plan 配额数据面与两个展示面——按 provider 注册取数源与解析器（`sources.ts`）、5 分钟轮询、凭据解析缓存；footer 配额段委托其渲染，pi-web 状态架子由它直发。跨扩展经 ESM 单例共享快照，数据到达经 `onQuotaChange` 通知 footer 重绘，渲染帧不再触发取数。决策记录见 `docs/adr/0004-coding-plan-independent-extension.md`
- **tc-footer**：配额窗口统计支持 OpenCode Go（`opencode-go`）——官方 usage 端点一次返回 rolling / weekly / monthly 三档窗口，footer 并列展示 ⏳5h / ⏳7d / ⏳30d（GLM 仍为 ⏳5h + ⏳7d）；各窗口健康态基线色互不相同，一眼区分当前 provider，告警阈值（≥70 黄 / ≥90 红）仍压过基线色。决策记录见 `docs/adr/0003-opencode-go-quota-windows.md`

### Fixed

- **tc-footer**：配额快照与 API key 按 provider 隔离——原实现全局只缓存一个 key，会话中途切换 provider 会拿错 key；切换后旧快照不再渲染、也不发布到 pi-web 状态栏
- **tc-footer**：配额 `percent = 0` 时不再显示倒计时——上游此刻的 `resetsAt` 是「当前时刻 + 窗口」占位符而非真实重置时刻；解析完全防御式，字段异常的窗口直接跳过、全部不可用则整段不更新

## [0.11.1] - 2026-09-22

### Fixed

- **tc-footer**：⚡ tok/s 流式刷新节流 250ms → 1s——刷新节奏与 1s 滑动窗口对齐，每次刷新读到一整个新窗口，数字不再高频跳动

## [0.11.0] - 2026-09-22

### Added

- **tc-footer**：实时 token 速度段 `⚡42.3 tok/s`——一个 agent run（`agent_start`→`agent_end`）内以 1s 滑动窗口测 tok/s，工具执行期间暂停计时；`text_delta`/`thinking_delta` 按词边界正则估算 token，`message_end` 用 provider `usage.output` 校准总数，因此结束后定格的整轮平均是精确值。按速度等级着色（`<50` error / `50–100` warning / `100–200` success / `≥200` accent，满速锚点 300 tok/s），流式期间 250ms 节流刷新 + 尾部补刷；参考 [pi-token-speed](https://github.com/gsanhueza/pi-token-speed) 实现。术语定义见 `CONTEXT.md`

### Changed

- **tc-footer**：思考等级图标 ⚡ → ✦（⚡ 归 token 速度段专用，见 `CONTEXT.md` 词条）；窄终端截断顺序明确为 plan → token 速度 → 分支名，模型 id 与上下文进度条始终优先（顺带修复原实现先截断后比较、plan 段实际永远不会被丢弃的问题）
- **preview**：`npm run footer-preview` 默认列宽 80 → 120（Mac 终端常见宽度），并新增速度四档与丢段顺序的演示

## [0.10.0] - 2026-09-14

### Added

- **tc-footer**：上下文进度条在标称窗口超过 650k 上限时追加 dim 色 `Smart Zone` 标签——百分比与进度条以截断后的有效上下文窗口为分母，标签明示这一点，避免“1M 模型的 67%”被误读为标称窗口占比；未截断的窗口不加标注。术语定义见 `CONTEXT.md`
- **docs**：新增有效上下文窗口调研报告 `docs/research/effective-context-window.md`（一手来源：Chroma context rot、RULER、NoLiMa、LangWatch 真实 trace、pi 与 Claude Code 源码对照）

### Changed

- **tc-footer**：Smart Zone 上限 450k → 650k，截断窗口红线 65% → 85%（≈552.5k，仍早于 pi 真实 compaction 点 98.4%）——300–450k 区间（生产实践验证可用：Claude Code 1M 会话 96.7% 才压缩）不再误标红；阈值依据见调研报告

## [0.9.0] - 2026-09-10

### Added

- **tc-footer**：pi-web 等没有 footer 的界面（RPC 模式下 `setFooter` 是 no-op）也能看到 coding plan 配额窗口——同一段 5h + 7d 窗口改由扩展状态栏（`setStatus("coding-plan")`）展示，切走 `zai-coding-cn` 即清除；终端 footer 的配色来自 theme，网页端改用 ANSI（RPC 的扩展 theme 是 no-op stub，`fg()` 原样返回文本），已发布文本做缓存避免重复推送。决策记录见 `docs/adr/0002-pi-web-plan-status.md`
- **extension**：新增 `deepseek-v4.1-flash-ioa`（DeepSeek V4.1 Flash）模型条目：支持图片输入（实测能读出图片内容）、1M 上下文、384K 输出，思考档位沿用 `all`

### Changed

- **extension**：`deepseek-v4-flash-ioa` 替换为 `deepseek-v4.1-flash-ioa`——新 ID 是 V4.1 的显式入口（旧 ID 为上游已弃用名，请求会被路由到 V4.1-Flash）；旧 ID 在网关上仍可用，但已从目录移除，固定过它的配置需改用新 ID。DeepSeek 两个条目的输出上限 50000 → 384000，模型快照复核日期更新为 2026-09-10

## [0.8.0] - 2026-09-03

### Added

- **warp-notify**：标签页 spinner 动画支持多版本——dots10（细密盲文旋转）、breathe（亮度呼吸条）、bounce（单点弹跳）、corner（角灯转动）、box（方块充填）、pie（饼图旋转）六组候选，每组自带帧数与节奏；每次会话启动时（模块加载，进程=会话）随机抽取一组，整段会话保持同一动画

### Changed

- **package**：重命名为 `pi-kit`（npm 包名 + GitHub 仓库地址 `git:github.com/asiazhang/pi-kit`），旧名 `pi-codebuddy-kit` 停用；README 安装/更新/卸载命令同步更新

## [0.7.1] - 2026-09-01

### Fixed

- **warp-notify**：修复 `/new`、`/resume`、`/fork` 或退出替换顶层会话时，仍在计数的孤儿子代理运行使共享计数器无法归零、新会话的 run 永不发 `stop`、Warp tab 卡在 "In progress" 的问题——顶层会话 teardown 视为丢弃整棵运行树，先 flush 持有的 stop 再重置全部共享状态；子代理自身的 teardown 仍只释放自己的份额，不打扰仍在进行的父运行

## [0.7.0] - 2026-09-01

### Added

- **tc-footer**：model-id 按 provider 上色——tencent-copilot（CodeBuddy 网关）显示为 accent 青色，GLM coding plan（`zai-coding-cn`）显示为 thinkingXhigh 紫色（与 7 天额度的 thinkingHigh 同族、深一档避免混淆），其它 provider 保持默认文字色；`footer-preview` 镜像同步更新

### Fixed

- **warp-notify**：修复启动时 announce `session_start` 使 Warp tab 一直卡在 "In progress" 的问题——Warp 状态枚举无 idle，boot（startup）的 session_start 不再 announce，会话 announce 收敛到 `agent_start`（与 `prompt_submit` 配对，在 run 真正开始时由 Warp 构建 "In progress"）；子代理会话启动时仍标记，只是不再 announce

## [0.6.0] - 2026-08-31

### Added

- **tencent-copilot**：模型目录新增 GLM-5.3 Flash（`glm-5.3-flash-ioa`，1M 输入 / 48K 输出），与 GLM-5.3 同一批次可用

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
