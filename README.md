# pi-codebuddy-kit

[pi](https://github.com/earendil-works/pi-mono) coding agent 的模型提供方扩展：接入腾讯 CodeBuddy 网关（`https://copilot.tencent.com/v2`）。

注册 `tencent-copilot` provider，内置 17 个模型快照（Claude / GPT / Gemini / GLM / MiniMax / Kimi / Hunyuan / DeepSeek），支持图片输入、推理档位（effort）、工具调用。模型目录与网关兼容性参数于 2026-08-25 在线上网关逐模型验证。

另附带两个 provider 无关的扩展（默认启用，随包一起加载）：

- **自定义状态栏**（`tc-footer`）：单行显示工作目录、按有效上下文窗口计算的用量百分比与 10 格进度条、GLM coding plan 5 小时配额窗口（`⏳5h 42% ██░░░ ↻2h15m`，蓝色进度条，与绿色上下文条区分，仅在使用 `zai-coding-cn` 且已存 key 时显示，5 分钟轮询）、模型 id、思考等级（⚡）、git 分支。上下文颜色阈值跟随 pi 的自动压缩触发点动态计算，分支与思考等级变化时自动重渲染。
- **系统提示词注入**（`system-prompt`）：每轮向系统提示词追加用户偏好（bash 搜索使用 `rg`，尊重 .gitignore）。
- **Warp 终端通知**（`warp-notify`）：仅在 Warp 终端内激活（`TERM_PROGRAM=WarpTerminal`），向控制终端写 OSC 777 结构化事件，会话开始/提交提示词/提问阻塞/回答结束/空闲时弹系统通知；turn 进行中用盲文帧动画 tab 标题（转点），每 15s 心跳重报避免 Warp 把 tab 标记为空闲。状态机按 in-flight 计数实现，SubAgent（含并发后台子代理）不会提前关掉父会话的动画或发出假 toast；非 Warp 环境零注册零输出。移植自 `@juicesharp/rpiv-warp`，修复其子会话共享状态缺陷。

## 安装

```sh
pi install git:github.com/asiazhang/pi-codebuddy-kit
```

或临时试用（不写入设置）：

```sh
pi -e git:github.com/asiazhang/pi-codebuddy-kit
```

## 配置 API key

在 CodeBuddy 个人密钥页创建 API key，然后在 pi 会话里登录，key 会存入 `~/.pi/agent/auth.json`：

```
/login
```

选择 `tencent-copilot`，粘贴 `ck_...` 开头的 key 即可。`/logout` 可移除存储的 key。

## 更新扩展

更新已安装的扩展包（拉取远程最新代码）：

```sh
pi update --extension git:github.com/asiazhang/pi-codebuddy-kit
```

或一次性更新所有已安装的扩展包：

```sh
pi update --extensions
```

更新后重启 pi 会话生效。卸载用 `pi remove git:github.com/asiazhang/pi-codebuddy-kit`。

## 使用

安装并配置 key 后，在 pi 会话里用 `/model` 选择 `tencent-copilot/<model>`，或命令行指定：

```sh
pi --model tencent-copilot/glm-5.3-ioa
```

设为默认模型（`~/.pi/agent/settings.json`）：

```json
{
  "defaultProvider": "tencent-copilot",
  "defaultModel": "glm-5.3-ioa"
}
```

### 模型目录

当前快照（17 个）：

| id | 名称 |
| --- | --- |
| `claude-sonnet-5-1m` / `claude-sonnet-4.6-1m` | Claude Sonnet 5 (1M) / 4.6 (1M) |
| `claude-opus-5` / `claude-opus-4.8-1m` / `claude-opus-4.7-1m` / `claude-opus-4.6-1m` | Claude Opus 5 / 4.8 (1M) / 4.7 (1M) / 4.6 (1M) |
| `gemini-3.1-pro` / `gemini-3.5-flash` | Gemini 3.1 Pro / 3.5 Flash |
| `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` | GPT-5.6 Sol / Terra / Luna |
| `glm-5.3-ioa` | GLM-5.3 |
| `minimax-m3-ioa` | MiniMax M3 |
| `kimi-k3-ioa` | Kimi K3 |
| `hy3-ioa` | Hy3 |
| `deepseek-v4-flash-ioa` / `deepseek-v4-pro-ioa` | DeepSeek V4 Flash / Pro |

## 网关兼容性说明

网关是 OpenAI Chat Completions 兼容接口，但有若干差异，扩展已逐一适配：

| 适配项 | 说明 |
| --- | --- |
| 流式 | 网关只接受流式请求（`stream: true`），非流式直接拒绝 |
| 请求头 | 携带 CodeBuddy CLI 身份头（`x-codebuddy-request`、`x-ide-type/name/version` 等） |
| `max_tokens` | 网关不认 `max_completion_tokens`，且 `max_tokens` 有最小值限制 |
| `system` 角色 | 不使用 `developer` 角色 |
| 不发 `store` / `strict` | 网关不接受这两个字段 |
| 推理档位 | `reasoning_effort` 支持 low / medium / high / xhigh / max；当前快照全部模型均接受 |

## 开发

克隆后直接编辑 `extensions/` 下源码，本地试运行：

```sh
pi -e ./path/to/pi-codebuddy-kit
```

类型检查与 lint（Biome）：

```sh
npm install
npm run typecheck
npm run lint
```

预览自定义 footer 的渲染效果（无需真实会话，支持列宽与 `PI_THEME`）：

```sh
npm run footer-preview
npm run footer-preview 60
PI_THEME=light npm run footer-preview
```

命令、格式化规则与编辑纪律见 [AGENTS.md](AGENTS.md)。

模型快照以元组数组维护（`SNAPSHOT`，位于 `extensions/tencent-copilot.ts`），新增模型只需加一行。

## License

MIT
