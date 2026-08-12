# Nekoder

Nekoder 是一个以 Agent Run 为核心的终端编程助手。当前 TUI 使用 Bun、Ink 7 和 React 19.2，支持流式文本、工具生命周期、Plan→Do、逐条命令审批、取消和 token 统计。

## 启动

```powershell
bun install
bun run demo
```

Demo 不需要 API Key，并且仍经过真实的 `AgentSession → SessionController → TuiStore → Ink Renderer`。可尝试：

- `show a tool`：运行无副作用的演示读取工具；
- `/plan`，随后输入 `request approval`：显示命令审批卡；
- `/execute`（或 `/exec`）：不执行计划，直接退出 Plan Mode；
- `interrupt stream`：检查部分文本的中断标记；
- Plan 成功后输入 `/do`：执行活动计划。

使用 `bun run start` 启动正式模式。它会从现有 Nekoder 配置加载首个 Provider，在进入 alternate screen 前连接可信的 MCP Server，并把发现到的工具接入统一 Tool Registry。Workspace 提供的 MCP 配置首次启用或变化时会先请求信任；拒绝或单个 Server 失败不会阻止核心工具启动。

如需记录每次模型调用的完整语义输入与输出，可启用 JSONL hook：

```yaml
llm_io_hook:
  enabled: true
  path: .nekoder/logs/llm-io.jsonl
```

日志覆盖 Root、SubAgent、上下文压缩和记忆作业共享的模型调用。它会包含完整提示词、消息、工具定义、结果与错误，可能含敏感内容；请限制文件访问权限，且不要提交该日志。

## 自定义 Hook

项目 Hook 放在 `.nekoder/hooks/*.yaml`，用户 Hook 放在 `~/.nekoder/hooks/*.yaml`，无需额外注册。可监听系统启动/退出、Session 开始/结束、上下文压缩、错误以及 Agent/Tool 生命周期，并执行 HTTP、命令、提示注入、SubAgent 或工具拒绝：

```yaml
version: 1
hooks:
  - id: notify-error
    event: system_error
    action:
      http:
        url: https://hooks.example/error
        method: POST
  - id: cleanup-session
    event: session_end
    action:
      command: bun scripts/session-ended.ts
```

Hook 配置即执行授权：HTTP 与命令不经过工具审批或安全策略，并以 Nekoder 进程当前用户身份运行。完整 Schema 与信任模型见 [`docs/hook-system.md`](./docs/hook-system.md)。

可选参数：

```text
--demo           无 API Key Demo
--debug          显示内存 UI 诊断
--plain-icons    不使用 Nerd Font 图标
--reduce-motion  关闭非必要动画
```

## 交互

- `Enter`：提交；`Shift+Enter`：换行；
- `Home` / `End`、方向键、`Backspace` / `Delete`：编辑草稿；
- `Ctrl+Z` / `Ctrl+Y`：撤销/重做；
- `Tab`：当光标位于开头 Slash token 时补全命令，单匹配直接补全、多匹配显示菜单；其他位置在 Composer 与时间线 Browse 间切换；
- `PageUp` / `PageDown` 或滚轮：浏览时间线；
- 审批时按 `Y` 单次允许、`N` 拒绝、`Esc` 取消 Run；
- Run 中 `Ctrl+C` 或 `Esc`：取消；空闲时 `Ctrl+C` / `Ctrl+D`：退出。

鼠标采用 SGR 1006，支持滚轮、工具卡点击和审批点击；所有鼠标动作均有键盘等价路径。

内置 Slash 命令包括 `/help`、`/compact`、`/clear`、`/cls`、`/plan`、`/execute`（`/exec`）、`/do`、`/session`、`/memory`、`/permission`、`/provider`（`/model`）、`/status` 和 `/review`。使用 `/provider` 查看已配置项，使用 `/provider <name>` 为当前进程切换 Provider；活动 Agent Run 期间不能切换。上下文压缩、Markdown Memory Note 与项目本地 JSONL Session 均通过本地 Slash 动作管理，不会把命令文本转交 Agent。

Session、上下文压缩、Project Instructions、Memory Notes、Tool Artifacts 与后台记忆作业的完整设计见 [`docs/continuity-system.md`](./docs/continuity-system.md)；可执行需求规格见 [`.scratch/continuity/spec.md`](./.scratch/continuity/spec.md)。

MCP 配置使用 `mcp_servers` map，支持 `transport: stdio` 的 `command`/`args`/`env`，以及 `transport: http` 的 `url`/`headers`。`${VAR}` 只在显式 `env` 与 `headers` 值中展开；远程 URL 默认必须使用 HTTPS，loopback 地址可使用 HTTP。完整契约见 `goal.md` 的 MCP 章节。

## 布局与安全

- 80–119 列：单列时间线；120 列及以上：增加 24 列猫咪状态侧栏；低于 80 列尽力降级；
- 50 个时间线项目后启用视口虚拟化；
- 默认图标依赖 Nerd Font，可用 `--plain-icons` 降级；
- 尊重 `NO_COLOR` 和 `INK_SCREEN_READER=true`；颜色始终伴随文本状态；
- 模型文本、工具数据和路径在渲染前移除 ANSI、OSC 与危险控制字符；Markdown 仅支持受控文本子集；
- 命令审批始终显示完整 command、cwd，并明确 Nekoder 无法证明命令绝无副作用。

## 验证

```powershell
bun test
bunx tsc --noEmit
```
