# pi-kit

pi 编码代理的扩展工具包（provider 注册 + 状态栏 + 系统提示词注入 + Warp 通知）。本文件是项目术语表。

## Language

**上下文用量 (Context usage)**:
当前会话上下文相对有效上下文窗口的占用比例，由 footer 的百分比与进度条展示。
_Avoid_: token 百分比、memory 占用

**Smart Zone**:
上下文进度条上的有效区间标签。有效上下文窗口设有保守上限，标称窗口超过上限的模型按上限计；此时 footer 以 `Smart Zone` 标注进度条，提示百分比与进度条描述的是这个区间，而非标称窗口。未截断的窗口不标注。
_Avoid_: of 450k、有效窗口后缀

**Coding plan**:
按配额窗口计费的 LLM 订阅计划（区别于按 token 计量），当前指 GLM coding plan（pi provider `zai-coding-cn`）与 OpenCode Go（pi provider `opencode-go`，额度以美元计量）。
_Avoid_: 套餐、credits

**配额窗口 (Quota window)**:
coding plan 的滚动计量周期，到期自动重置并恢复配额。
_Avoid_: 账单周期

**5h 窗口 (5h window)**:
coding plan 的 5 小时滚动配额窗口，随消耗滚动刷新；与 7 天窗口并列展示，是更频繁触发的节流窗口。
_Avoid_: 5 小时限额

**7 天窗口 (7 day window)**:
coding plan 的周配额窗口，自订购起以 7 天为周期刷新；是全周的硬上限，5h 窗口耗尽、重置后它才成为真正的约束。footer 以 ⏳7d 展示。
_Avoid_: 周窗口、每周窗口

**窗口重置 (Window reset)**:
配额窗口重置、配额恢复的时刻；footer 以 ↻ 倒计时展示。
_Avoid_: 过期时间

**token 速度 (Token speed)**:
AI 流式输出时的实时生成吞吐，单位 tok/s；footer 以 `⚡<数值> tok/s` 展示，⚡ 图标专属此段。工具执行期间时钟暂停、读数冻结，footer 置灰并以 `⚡⏸<数值>` 展示。
_Avoid_: TPS、生成速率

**速度等级 (Speed tier)**:
按 token 速度划分的四档，以 footer 颜色承载：<50 为不可接受（红），50–100 勉强可用（黄），100–200 快（绿），≥200 接近满速（青，满速锚点 300 tok/s）。
_Avoid_: 速度段

**思考等级 (Thinking level)**:
模型推理深度档位，footer 以 `✦<等级>` 展示；⚡ 归 token 速度专用，两者不混用。
_Avoid_: 思考模式
