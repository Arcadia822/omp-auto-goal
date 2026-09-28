# omp-auto-goal

让带标记的 OMP 斜杠命令**自动接入 goal 模式**：命中标记时挂载 `goal` 工具、注入 guided-goal 的访谈协议，命令自身的指示照常执行；goal 离开 active 后自动摘掉工具。

## 为什么需要扩展

markdown 命令（`~/.omp/agent/commands/*.md`）**无法**开启 goal 模式：

- `/goal`、`/guided-goal` 是 TUI 内置命令，由内置注册表在 `AgentSession.prompt()` 之前分发；文件命令只是 prompt 文本展开，frontmatter 只认 `description` / `argument-hint`。
- `goal` 工具是门控控制工具：只有 `getGoalModeState()?.enabled === true` 时才会进入默认工具集（`rebuildToolSet`），否则调用即抛 `Goal mode is not active.`。
- agent 没有改动自身工具集的工具；`setActiveTools` 只对扩展开放。能挂载 `goal` 的只有内置 `/goal`、`/guided-goal` 和调用 `pi.setActiveTools()` 的扩展——也就是本插件。

## 安装

把仓库克隆到任意目录 `<plugin-dir>`（示例：`~/Documents/omp-auto-goal`）。

在 `~/.omp/agent/config.yml` 注册：

```yaml
extensions:
  - <plugin-dir>
```

或用 `omp plugin link <plugin-dir>`。重启会话后生效（扩展在启动时加载）。

`node_modules/@oh-my-pi/pi-coding-agent` 是指向全局 omp 安装的符号链接（只为 `tsc` / 编辑器解析类型）：

```bash
mkdir -p node_modules/@oh-my-pi
ln -sfn ~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent node_modules/@oh-my-pi/pi-coding-agent
bun install
```

## 用法

在任意命令 markdown 的正文里加一行标记（可写成引用行）：

```markdown
omp-auto-goal: on
```

命令展开后标记出现在用户消息中，插件即介入。已接入的命令：`/prepare`、`/develop`。

标记**必须是一行纯文本，不能用 `<!-- -->` 注释**：宿主在 prompt 渲染阶段会执行
`text.replace(/<!--[\s\S]*?-->/g, "")`，注释在到达扩展之前就被剥掉。匹配是整行匹配
（允许引用前缀与任意空白），正文里顺带提到标记不会触发。

## 行为

1. `before_agent_start` 命中标记且 `goal` 工具**不在**活动工具集时 → 把 `goal` 挂进活动集（保留原有工具，只做增量）。
2. 同一个请求注入一条 agent 归属的协议消息，三阶段：
   - **先调研（允许工具）**：读 Issue、分支/PR、frozen Taco、仓库规范与同类实现，把五段落到证据上。
   - **判定**：五段可推定且每条 `Success criteria` 可评测 → **跳过访谈**直接创建；有缺项 → 用**一次 `ask` 批量问**这些缺项（每项 2–5 个带取舍的选项、总数 ≤5），不在聊天里来回问答；`ask` 不可用（无头环境）时只发 objective 草案请用户确认，不创建 goal。具体哪些该问由命令自身决定，命令把某类决策留到交付后再收集时此时不问。
   - **创建**：`goal` (`op: "create"`)，objective 必须是 `## Objective` / `## Success criteria` / `## Verification` / `## Boundaries` / `## Stop conditions` 五段。
   与内置 `/guided-goal` 的差别：内置模板要求 `interview before other work` 且访谈期间 `no tool calls`，即**不能先调研、也没有跳过条件**。
3. 已在 goal 模式（`goal` 工具已在活动集）时不重复挂载、不再注入：命令正文已覆盖这一情形，而 goal 模式的每轮 continuation 都会带上含标记的上下文，重复注入只会刷屏。
   例外：在 handler 里调用 `setActiveTools()` 会改变系统提示基底，宿主因此丢弃该次准备返回的消息并重跑准备（最多三次）。重跑时工具虽已在活动集，只要本轮契约尚未落地就再交一次；`turn_end` 清掉这个待交付标记。
4. 挂载失败（`goal.enabled=false`，或会话处于受限工具集）时，协议要求 agent 停下说明原因，不得模仿 goal 模式。
5. `goal_updated` 显示 goal 不再 active（完成/丢弃/暂停）时摘掉 `goal` 工具，与内置 `/goal` 的退出路径一致；active 与 budget-limited 不动。之后再次运行带标记的命令会重新挂载并注入。

注入的消息 `display: false`（与 magic keywords 的隐藏提示同类），不刷屏；goal 状态在 footer 显示。

## 限制

- 需要 `goal.enabled=true`（默认 true）。
- goal 模式与 plan 模式（含 paused）、vibe 模式互斥；冲突时插件仍会挂载工具，协议要求 agent 停下说明。
- goal 的自动续跑只在交互式会话生效（`goal.continuationModes=["interactive"]`）；`omp -p` 等无头模式只能创建 goal，不会有 continuation 循环。
- 标记按整条 prompt 匹配：把旧消息（含标记）作为 steer 重发会再次注入协议；协议本身幂等（已有 active goal 时要求 `get` 核对而不是重复创建）。

## 开发

```bash
bun test tests        # 行为测试（标记命中、协议内容、工具集挂载/还原）
tsc --noEmit -p .     # 类型检查
```

运行日志：`~/.omp/logs/omp.<date>.<pid>.log`，看 `[omp-auto-goal]` 前缀（`goal tool armed` / `goal tool released` / `goal tool unavailable`）。
