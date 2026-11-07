# footer 配额窗口统计支持 Command Code GOAT（复用 OpenCode Go 的仪表）

pi-kit 已有 commandcode provider（`extensions/commandcode.ts`，GOAT 订阅）。GOAT 和现有两个 coding plan 一样按配额窗口节流：`docs/resources/pricing-limits` 写明每个订阅计划除月度池外还有 5 小时与周两个滚动窗口，按 credit 值计量（GOAT 当前 $14 / $35，月度最多 $70/$100）。为了让 footer 在 GOAT 下也显示配额，我们给它注册第三个 `QUOTA_SOURCES` 条目。

### 关键取舍

- **数据源：未入文档的 `/alpha` 计费端点**。文档化的 Provider API 没有任何计费路由（`/provider/v1/usage`、`/credits`、`/limits` 全是 404），真正的来源是 `cmd` CLI 自己读的 `GET https://api.commandcode.ai/alpha/billing/credits`（Bearer 即 chat 用的同一把 key，2026-11-07 实测 200）：`windowLimits.{fiveHour,weekly}` 各带 `{used, cap, exceeded, resetAt}`，`resetAt` 是**毫秒**时间戳（同域的 429 拒绝体里 `rateLimit.reset` 是秒——同义不同单位，别混用）。`/alpha` 前缀本身就声明不稳定，因此解析与其他两个来源同样防御式：`cap` 非数字或 ≤0、`used` 非数字的窗口直接跳过，全部不可用则整段不更新、保留上一份快照（随后照常 10 分钟转暗），`404` 只是让这段消失，不会崩。
- **端点回的是用量比，不是百分比**：GLM 给 `percentage`，Go 给 `percent`，GOAT 给 `used`/`cap`，所以在解析器里折算成 0–100（`used / cap * 100`，不取整，精度留给渲染层 `Math.round`）。`credits.monthlyCredits` 是**剩余**月度池，与 Go 的 `monthly` 一样不展示——它是最松的一档，日常不构成约束。
- **显示完全复用 OpenCode Go**：同样的 `⏳5h`（accent 青）+ `⏳7d`（mdLink 蓝）两个仪表、同样的 20 格、同样的 ≥70% 黄 / ≥90% 红。原本「每个 plan 一套基线色，便于一眼区分」的规则在这里刻意让位：GOAT 与 OpenCode Go 读的是同一种窗口（滚动 5h + 周、credit 值计量），且两个订阅不会同时使用，再发明一套配色只会让仪表含义变模糊。model id 的 brand 色同理复用 `syntaxVariable` 蓝（tc-footer 的 `MODEL_COLORS`）。
- **0% 不显示倒计时**：沿用 Go 的规则。GOAT 在 `used = 0` 时窗口还没被首次请求打开，`resetAt` 只是「此刻 + 窗口」的占位（未逐位实测，但结论相同：此时倒计时没有信息量）；解析器以 `usedPercent > 0` 作为保留条件，用未取整的原始比例判断，避免把 0.4% 这种真实用量误判成 0。

### 影响

- `extensions/coding-plan/sources.ts`：新增 `COMMANDCODE_CREDITS_URL`、`COMMANDCODE_GAUGES`（直接复用 `GO_GAUGES`）、`parseCommandCodeQuotas()`，`QUOTA_SOURCES` 增加 `commandcode`。
- `extensions/coding-plan/sources.test.ts`：新增三组解析器测试（credit → 百分比折算与毫秒 `resetAt` 透传、0% 丢倒计时、不可用窗口跳过 / 全不可用 → `undefined`）。
- `extensions/tc-footer/index.ts` 与 `scripts/footer-preview.mjs`：`MODEL_COLORS` 增加 `commandcode → syntaxVariable`，预览镜像同步并补两条 GOAT 样例（含一条 88% 告警）。
- `CONTEXT.md` 的 Coding plan 词条纳入 GOAT；README 的 footer 说明同步。
- 轮询、上色、窄终端降级、pi-web 状态架全部沿用既有管线，无新增配置项；key 走 pi 的凭据系统解析（`commandcode` 的 auth：存 key 优先，`CMD_API_KEY` 兜底），因此没有 key 时这段就是不出现。
