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
- `interrupt stream`：检查部分文本的中断标记；
- Plan 成功后输入 `/do`：执行活动计划。

使用 `bun run start` 启动正式模式。它会从现有 Nekoder 配置加载首个 Provider，并在进入 alternate screen 前完成初始化。

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
- `Tab`：在 Composer 与时间线 Browse 间切换；Browse 中用方向键选择、`Enter` 展开工具卡、`Esc` 返回；
- `PageUp` / `PageDown` 或滚轮：浏览时间线；
- 审批时按 `Y` 单次允许、`N` 拒绝、`Esc` 取消 Run；
- Run 中 `Ctrl+C` 或 `Esc`：取消；空闲时 `Ctrl+C` / `Ctrl+D`：退出。

鼠标采用 SGR 1006，支持滚轮、工具卡点击和审批点击；所有鼠标动作均有键盘等价路径。

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
