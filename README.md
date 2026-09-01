# pi-kit

[pi](https://github.com/earendil-works/pi-mono) coding agent 的扩展工具包。核心是腾讯 CodeBuddy 接入：用 CodeBuddy 的 API key 在 pi 里使用 Claude / GPT / Gemini / GLM / MiniMax / Kimi / 混元 / DeepSeek 等模型，支持图片输入、推理档位、工具调用。

另附带几个 provider 无关的扩展（默认启用，随包一起加载）：

- **自定义状态栏**（`tc-footer`）：单行显示工作目录、上下文用量百分比与进度条、GLM coding plan 5 小时配额窗口（`⏳5h 42% ██░░░ ↻2h15m`，仅在使用 `zai-coding-cn` 且已存 key 时显示）、模型 id、思考等级（⚡）、git 分支。
- **系统提示词注入**（`system-prompt`）：每轮向系统提示词追加用户偏好（bash 搜索使用 `rg`，尊重 .gitignore）。
- **Warp 终端通知**（`warp-notify`）：仅在 Warp 终端内激活，会话开始、提交提示词、等待提问回答、回答结束、空闲时弹系统通知，turn 进行中在 tab 标题显示进行中动画；子会话（SubAgent）不会误触发通知。非 Warp 环境无任何行为。

## 安装

```sh
pi install git:github.com/asiazhang/pi-kit
```

或临时试用（不写入设置）：

```sh
pi -e git:github.com/asiazhang/pi-kit
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
pi update --extension git:github.com/asiazhang/pi-kit
```

或一次性更新所有已安装的扩展包：

```sh
pi update --extensions
```

更新后重启 pi 会话生效。卸载用 `pi remove git:github.com/asiazhang/pi-kit`。

> 注意：本包曾用名 `pi-codebuddy-kit`，旧仓库地址 `git:github.com/asiazhang/pi-codebuddy-kit` 已停用，请改用新地址。

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

当前包含以下模型：

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

网关与标准 OpenAI 接口存在若干差异（流式、请求头、参数字段等），扩展已内置适配，使用上无需额外配置。

## 开发

克隆后直接编辑 `extensions/` 下源码，本地试运行：

```sh
pi -e ./path/to/pi-kit
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

## License

MIT
