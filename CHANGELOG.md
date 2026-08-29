# Changelog

本项目的所有重要变更均记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-08-28

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
