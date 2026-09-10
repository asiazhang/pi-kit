# pi-web 的 coding plan 走扩展状态栏（setStatus）

tc-footer 用 `ctx.ui.setFooter` 替换整条状态栏，但 pi-web 的扩展 UI 上下文里 `setFooter` 是 no-op（`setHeader`、`setEditorComponent` 等同理），所以配额窗口在 Web 端完全不可见——打开网页只会看到 pi-web 自己的模型与上下文信息。

我们决定把**同一段** plan segment（`planSegment()` 仍是唯一实现）镜像到 `ctx.ui.setStatus("coding-plan", …)`，且只在没有 footer 的 UI 上发布（`ctx.mode !== "tui" && ctx.hasUI`）。pi-web 的 extension-status shelf 会渲染这段文本。

颜色改为调用方注入的 `PlanPainter`：终端传 `theme.fg`，Web 传 ANSI SGR。

### 关键取舍

- **状态栏 vs widget**：选状态栏。pi-web 的 widget 是「触发器 + 可折叠面板」，要点开才能看到配额；状态栏与终端 footer 一样常驻可见，语义最接近「一条状态栏」。代价是状态栏为单行、`white-space:pre` 且横向可滚动，窄视口下两条 20 格 bar 需要横向拖动（不做窄屏降级，与 ADR 0001 一致）。
- **ANSI 硬编码 vs 无色文本**：选 ANSI。配额仪表盘的价值在于「一眼看到告警」，无色 bar 只剩填充格数可读；pi-web 的状态栏本就经 ansi_up 渲染，而 RPC 模式的扩展 theme 是 no-op stub（`fg()` 原样返回文本），扩展想要颜色只能用 ANSI。代价是：其它 RPC 客户端若原样打印状态文本，会看到转义序列（已知的 RPC 消费者只有 pi-web）。色值取中间调，深浅主题都可读。
- **只在非 TUI 发布 vs 两边都发**：只在非 TUI。终端里 footer 已展示 plan；再发一份 `setStatus` 会在自定义 footer 之外的地方重复出现（我们替换掉的 footer 并不渲染 statuses）。
- **不镜像 cwd / 上下文 / model / branch**：pi-web 自带头部与会话统计，只补它缺的配额窗口。

### 影响

- `planSegment()` / `quotaBar()` 的 `theme: Theme` 参数换成 `paint: PlanPainter`，渲染布局不变。
- 新增发布状态：`session_start`（重置快照后立即同步并触发首次轮询）、`model_select`（切走 provider 时清除）、每次配额轮询成功后；已发布文本做缓存，避免重复推送相同的 segment。
- `scripts/footer-preview.mjs` 镜像同步，新增 pi-web 状态栏预览段（ANSI）。
