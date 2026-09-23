# footer 配额窗口统计支持 OpenCode Go（三窗口 + 独立配色）

footer 的配额窗口原先只接 GLM coding plan（`zai-coding-cn`，bigmodel.cn 配额接口）。OpenCode Go（provider `opencode-go`）同样是按配额窗口计费的 coding plan：`GET https://opencode.ai/zen/go/v1/usage`（Bearer 即 chat 用的 API key，未入官方文档但 2026-08 上线后稳定）一次返回 rolling / weekly / monthly 三档窗口的 `percent` 与 `resetsAt`（2026-09-23 实测 200）。我们决定把配额来源抽象成按 provider 注册的 `QUOTA_SOURCES`（url + parse），GLM 与 OpenCode Go 共用同一套轮询（5 分钟）、快照转暗（10 分钟）、告警阈值（≥70 黄 / ≥90 红）与 `PlanPainter` 上色管线（TUI 走主题色，pi-web `setStatus` 镜像走 ANSI，见 0002），并在 footer 并列展示 Go 的三档窗口（⏳5h / ⏳7d / ⏳30d）。

### 关键取舍

- **数据源**：用未入档但已稳定的官方 JSON 端点，不做控制台抓取、不做本地 DB 估算（cc-switch#6433 的结论：官方端点出现后抓取与估算方案全部废弃）。风险是端点可能随前端改版变更——它上线一小时内就重塑过一次响应——因此解析完全防御式（`status != "ok"`、`percent` 非数字的窗口直接跳过，全部不可用则整段不更新），并由 `tc-footer.test.ts` 锁住行为。
- **0% 时不显示倒计时**：上游 `percent = 0` 时 `resetsAt` 是「此刻 + 窗口」占位符而非真实重置时刻（真实 key 验证），显示会误导，直接丢弃。
- **配色（目的：一眼区分是 GLM 还是 OpenCode Go）**：每个窗口有自己的健康态基线色，且同一标签下与 GLM 不同——Go 是 5h `accent` 青 / 7d `mdLink` 蓝 / 30d `thinkingHigh` 紫，GLM 是 5h 蓝 / 7d 紫。三色互不相同，避开绿（context 条的健康色）与黄红（告警色），切换 provider 时仪表组观感不同；告警阈值仍然压过基线色。`PlanColor` 随之增加 `accent`，pi-web 的 ANSI 表用 109（`#87afaf`）承接青色基线。
- **窄终端降级**：沿用「按**未截断**宽度逐档尝试」的框架（截断后的字符串永远不超过宽度，拿它比较等于降级失效），在原有 plan → token speed → branch 的优先级内细化 plan 段：先按渲染顺序丢最后一个（最慢的）窗口，窗口丢完才轮到整段、再 token speed、再分支；model id 与 context 条始终保留。代价是窄终端最先看不到 ⏳30d，换来 model id 永远保得住。
- **快照与 key 按 provider 隔离**：快照携带 provider id，切换 provider 后旧快照不渲染、也不发布到 pi-web 状态栏；API key 按 provider 分别解析缓存（原实现全局缓存一个，会话中途切 provider 会拿错 key）。

### 影响

`tc-footer.ts` 的 `PlanWindows` 结构改为 `QuotaSnapshot { provider, gauges[] }`（gauge 自带 label + baseline），`planSegment` 拆成 `quotaBars`，渲染层的逐档降级循环改为 (gaugeCount, keepSpeed, keepBranch) 候选序列；`scripts/footer-preview.mjs` 镜像同步（默认列宽维持 120——三窗口全宽约 190 列，末尾提供 160 / 200 列的降级演示），并新增 Go 三窗口样例与 pi-web ANSI 行；解析测试并入已有的 `extensions/tc-footer.test.ts`（与 pi-web 镜像测试同文件）。降级行为对 GLM 同样生效。术语表新增「30 天窗口」，coding plan 词条纳入 OpenCode Go。
