# pi-codebuddy-kit

pi 编码代理的腾讯 CodeBuddy 接入包（provider 注册 + 状态栏 + 系统提示词注入）。本文件是项目术语表。

## Language

**上下文用量 (Context usage)**:
当前会话上下文相对有效上下文窗口的占用比例，由 footer 的百分比与进度条展示。
_Avoid_: token 百分比、memory 占用

**Coding plan**:
按配额窗口计费的 LLM 订阅计划（区别于按 token 计量），当前指 GLM coding plan（pi provider `zai-coding-cn`）。
_Avoid_: 套餐、credits

**配额窗口 (Quota window)**:
coding plan 的滚动计量周期，到期自动重置并恢复配额。
_Avoid_: 账单周期

**5h 窗口 (5h window)**:
coding plan 的 5 小时滚动配额窗口，是 footer 唯一显示的配额窗口（周窗口不用）。
_Avoid_: 周窗口

**窗口重置 (Window reset)**:
配额窗口重置、配额恢复的时刻；footer 以 ↻ 倒计时展示。
_Avoid_: 过期时间
