# coding plan 配额独立为扩展，经共享快照供 footer 消费

tc-footer 最初把配额取数（端点、解析器、5 分钟轮询、凭据解析）和两个展示面（footer 段、pi-web 状态架）全部写在一个渲染文件里，footer 文件承载了大量与「渲染一行状态」无关的代码。我们决定把 coding plan 配额拆为独立扩展 `extensions/coding-plan/`：它拥有数据面与两个展示面（footer 段委托其渲染函数、pi-web 架子由它直接发布），跨扩展经 ESM 单例（`state.ts`，与 warp-notify 的共享状态同机制）共享快照；tc-footer 只读取快照并渲染。

### 关键取舍

- **独立扩展 vs footer 目录内模块**：选独立。配额本来就不是 footer 的领域——pi-web 状态架（ADR 0002）与 footer 毫无关系，却是配额的第二个展示面；按产品边界切，数据面完全自治。代价是两个扩展各自持有生命周期处理器（pi.on 不可注销，session_start / model_select / session_shutdown 两边各接各的）。
- **接缝方向**：footer → coding-plan 单向。footer 只导入 `state.ts` 的快照读取与 `render.ts` 的 `quotaBars`；渲染帧不触发取数（原渲染帧惰性轮询钩子移除），新鲜度由 coding-plan 自己的定时器与事件保证（≤5 分钟）。
- **数据到达通知**：`state.ts` 提供 `onQuotaChange` 订阅，footer 用它触发重绘——与 pi 自身 `footerData.onBranchChange` 同型，轮询成功即重绘的行为不因拆分而丢失。

### 影响

- `extensions/tc-footer.ts` 拆为 `extensions/tc-footer/`（context / speed / index），配额代码迁入 `extensions/coding-plan/`（state / sources / render / index）；测试沿模块缝拆分，无 re-export 兼容层。
- `scripts/footer-preview.mjs` 的 mirror 注释路径同步刷新（渲染逻辑不变）。
