/**
 * omp-auto-goal — 让带 `omp-auto-goal: on` 标记行（可写成引用行 `> omp-auto-goal: on`）的斜杠命令自动接入 OMP goal 模式。
 *
 * 为什么必须由扩展来做：markdown 命令无法开启 goal 模式。`goal` 工具只在
 * `getGoalModeState()?.enabled === true` 时才进入默认工具集（`rebuildToolSet`），
 * agent 也没有改动自身工具集的能力；能挂载它的只有 TUI 内置 `/goal`、`/guided-goal`
 * 以及调用 `pi.setActiveTools()` 的扩展。文件命令只是 prompt 文本展开。
 *
 * 机制：
 * 1. 命令 markdown 里写一行标记，命令展开后标记出现在用户消息里。
 * 2. 本扩展在 `before_agent_start` 命中标记时，把 `goal` 工具挂进活动工具集，
 *    并注入 guided-goal 的访谈协议（每回合只问一个问题 → 五段齐全 → `goal` op:create）。
 * 3. goal 离开 active（完成/丢弃/暂停）时摘掉 `goal` 工具，与内置 /goal 的退出路径一致。
 *
 * 标记必须是一行纯文本，不能用 `<!-- -->`：宿主在 prompt 渲染阶段会剥掉 HTML 注释
 * （`text.replace(/<!--[\s\S]*?-->/g, "")`），注释标记到不了这里。
 *
 * `before_agent_start` 的 prompt 只包含选中的用户消息，隐藏的 agent 归属消息被排除，
 * 所以本扩展注入的协议不会自我触发；goal 模式的继续（continuation）也不含标记。
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const GOAL_TOOL = "goal";
const CONTRACT_TYPE = "omp-auto-goal";
/** 整行匹配：允许引用前缀与任意空白，避免正文里顺带提到标记时误命中。 */
const MARKER_RE = /^[ \t]*>?[ \t]*omp-auto-goal[ \t]*:[ \t]*on[ \t]*$/im;

/** 命中的是「本回合存在带标记的命令」，不是「扩展已注入过协议」。 */
export function hasAutoGoalMarker(prompt: string): boolean {
  return MARKER_RE.test(prompt);
}

export interface ContractInput {
  /** `goal` 工具是否已在活动工具集中（本扩展挂载成功，或宿主已进入 goal 模式）。 */
  armed: boolean;
  /** 挂载失败的原因，仅在 armed 为 false 时有值。 */
  reason?: string | undefined;
}

export function buildContract({ armed, reason }: ContractInput): string {
  const status = armed ? "已由 omp-auto-goal 挂载" : `未挂载：${reason ?? "原因未知"}`;

  return [
    "# omp-auto-goal：goal 模式接入",
    "",
    "本回合的斜杠命令带 `omp-auto-goal` 标记，插件已处理 goal 模式接入。",
    "本协议只管 goal 模式接入与 goal 的创建规则（goal 状态、调研/访谈/创建、五段的格式）；**objective 各段落的具体内容、任务流程、交付格式、提问策略都由命令自身定义**，不要用本协议替代命令指示。",
    "",
    "## 接入状态",
    `- \`goal\` 工具：${status}`,
    "",
    "## 接入协议",
    '1. 先看 goal 状态：调用 `goal`（`op: "get"`）。',
    "   - 已有 active goal 且 objective 就是本次任务：不要重复创建，直接执行命令指示。",
    "   - 已有 active goal 但属于别的任务：停下，向用户说明并给出「复用」或「`/goal drop` 后重建」两个选项。",
    "   - goal 处于 paused：请用户执行 `/goal resume`，不要新建。",
    "   - 没有 goal：走第 2–5 步。",
    "2. **先调研，不要先问**（这一步允许、也要求使用工具）：按命令指示取证——命令要求读的源（工单/Issue、分支与 PR、既有规范与同类实现、相关文档等）都要实际读，而不是凭记忆作答。目标是把五段的每一段都落到证据上。",
    "3. 判定要不要访谈：",
    "   - 五段都能从证据与命令指示推出，且每条 `Success criteria` 可评测（有确切命令或产物能判定）→ **跳过访谈**，直接创建 goal；创建后用一句话说明五段各自来自哪条证据。",
    "   - 有缺项或弱项——会实质改变需求/验收/契约/边界/风险承担且无法从证据推定，或某条 `Success criteria` 判定不了——→ 进入访谈，只问这些缺项。**具体哪些该问由命令自身的指示决定**：命令要求把某类决策留到交付后再收集时，此时不问。",
    "4. 访谈用**一次 `ask` 批量问**，不要来回对话：",
    "   - 把缺项一次列进同一个 `ask`（`ask(questions=[…])`），每项给 2–5 个带取舍的选项与推荐项；不要一个回合只问一个问题，也不要在聊天里问答。",
    "   - 只列缺项，总数控制在 5 个以内；能从证据确定的字段不列。",
    "   - 用户可用自定义输入覆盖选项，按其输入落定。",
    "   - `ask` 不可用（无头 / 非交互环境）时：把缺项与推荐做法写成 objective 草案发在回复里请用户确认，**不创建 goal、不猜测**。",
    "   - 用户跳过或答不全：把该项按最保守推荐写入 objective 并标注「待确认」，或按命令指示留到交付后收集。",
    "5. 创建 goal：**只在用户明确给出 token 预算时**才传 `token_budget`；不要自行估算、不要用默认值（否则 goal 会直接落入 budget-limited）。objective 必须是下面五段、按此顺序的 markdown，内容按本任务写实，不要照抄模板：",
    "",
    "```markdown",
    "## Objective",
    "## Success criteria",
    "## Verification",
    "## Boundaries",
    "## Stop conditions",
    "```",
    "",
    "   - `Success criteria` 每一条都必须可被评测：测试通过、命令退出码 0、文件存在且具备某属性、审查无未处理项；拒绝「完成/干净/做好」。",
    "   - `Verification` 必须写 agent 自查用的确切命令或动作。",
    "   - `Boundaries` 必须写允许改动的范围，以及明确不碰的清单。",
    "   - `Stop conditions` 必须包含：需要人类决策或承担风险时停下请示、达到尝试上限或 token 预算时停下上报。",
    "6. 创建成功后：一句话确认，然后严格按本回合的斜杠命令工作；不要把「创建 goal」本身当成任务目标。",
    armed
      ? ""
      : "7. `goal` 工具未挂载时不要模仿或绕过 goal 模式：向用户说明具体原因（设置 `goal.enabled=false`，或当前处于 plan 模式（含 paused）/ vibe 模式），等待用户处理。仅当用户明确要求不用 goal 模式时，才按原命令流程执行并在交付中注明。",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export default function ompAutoGoal(pi: ExtensionAPI): void {
  /** 本扩展挂过 goal 工具的会话，用于退出时精确还原，不碰别的会话的工具集。 */
  const armedSessions = new Set<string>();
  /**
   * 已挂载但契约消息尚未落地本轮准备的会话。
   * 宿主在 handler 里调用 `setActiveTools()` 改变系统提示基底时会丢弃该次准备返回的消息并
   * 重跑准备（最多三次），所以重跑时必须再交一次；用 turn_end 收尾，避免 goal continuation 刷屏。
   */
  const pendingContract = new Set<string>();

  pi.on("turn_end", async (_event, ctx) => {
    pendingContract.delete(ctx.sessionManager.getSessionId());
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!hasAutoGoalMarker(event.prompt)) return;

    const sessionId = ctx.sessionManager.getSessionId();
    const before = pi.getActiveTools();
    const alreadyArmed = before.includes(GOAL_TOOL);

    if (alreadyArmed && !pendingContract.has(sessionId)) {
      // 会话本就处于 goal 模式（内置 /goal 进入，或上一轮已接入）：命令正文已覆盖这种情形，
      // 而 goal 模式的每轮 continuation 也会带上含标记的上下文，重复注入只会刷屏。
      return;
    }

    let armed = alreadyArmed;
    let reason: string | undefined;
    if (!armed) {
      try {
        await pi.setActiveTools([...before, GOAL_TOOL]);
        armed = pi.getActiveTools().includes(GOAL_TOOL);
        if (!armed) {
          reason = "宿主未注册 goal 工具（goal.enabled 可能为 false，或本会话被限制工具集）";
        }
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
    }

    if (armed) {
      armedSessions.add(sessionId);
      if (!alreadyArmed) {
        pendingContract.add(sessionId);
        pi.logger.info("[omp-auto-goal] goal tool armed", { sessionId });
      }
    } else {
      pi.logger.warn("[omp-auto-goal] goal tool unavailable", { sessionId, reason });
    }

    return {
      message: {
        customType: CONTRACT_TYPE,
        content: buildContract({ armed, reason }),
        attribution: "agent",
      },
    };
  });

  pi.on("goal_updated", async (event, ctx) => {
    // active 与 budget-limited 仍需要 goal 工具；paused / complete / dropped 都不需要。
    if (!event.state || event.state.enabled === true) return;

    const sessionId = ctx.sessionManager.getSessionId();
    if (!armedSessions.has(sessionId)) return;

    const tools = pi.getActiveTools();
    if (!tools.includes(GOAL_TOOL)) {
      armedSessions.delete(sessionId);
      return;
    }
    try {
      await pi.setActiveTools(tools.filter((tool) => tool !== GOAL_TOOL));
      armedSessions.delete(sessionId);
      pi.logger.info("[omp-auto-goal] goal tool released", { sessionId, status: event.goal?.status });
    } catch (error) {
      pi.logger.warn("[omp-auto-goal] failed to release goal tool", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
