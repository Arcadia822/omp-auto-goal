import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import ompAutoGoal, { buildContract, hasAutoGoalMarker } from "../index";

const MARKER = "omp-auto-goal: on";
const COMMAND_PROMPT = `输入：TACO-9\n\n${MARKER}\n\n## 执行前提：goal 模式\n继续按命令指示工作。`;
const FIVE_SECTIONS = [
	"## Objective",
	"## Success criteria",
	"## Verification",
	"## Boundaries",
	"## Stop conditions",
];

/** 插件实际读取的事件字段；宿主传入的完整事件是它的超集。 */
type BeforeAgentStartEventLike = { prompt: string };
type GoalUpdatedEventLike = { state?: { enabled?: boolean }; goal?: { status?: string } | null };
type Handler<E> = (event: E, ctx: ExtensionContext) => unknown;
interface ContractMessage {
	customType: string;
	content: string;
	attribution?: string;
}

interface Harness {
	pi: ExtensionAPI;
	tools: string[];
	setCalls: string[][];
	/** false 表示宿主未注册 goal 工具，等价于设置里 goal.enabled=false。 */
	goalToolAvailable: boolean;
	beforeAgentStart(event: BeforeAgentStartEventLike): Promise<{ message?: ContractMessage } | undefined>;
	goalUpdated(event: GoalUpdatedEventLike): Promise<void>;
	turnEnd(): Promise<void>;
}

function createHarness(initialTools: string[], goalToolAvailable = true): Harness {
	const tools = [...initialTools];
	const setCalls: string[][] = [];
	const handlers: {
		beforeAgentStart?: Handler<BeforeAgentStartEventLike>;
		goalUpdated?: Handler<GoalUpdatedEventLike>;
		turnEnd?: Handler<Record<string, never>>;
	} = {};

	const harness: Harness = {
		pi: undefined as unknown as ExtensionAPI,
		tools,
		setCalls,
		goalToolAvailable,
		beforeAgentStart: async (event) => (await handlers.beforeAgentStart?.(event, ctx())) as never,
		goalUpdated: async (event) => {
			await handlers.goalUpdated?.(event, ctx());
		},
		turnEnd: async () => {
			await handlers.turnEnd?.({}, ctx());
		},
	};

	const register = (event: string, handler: unknown): void => {
		// 宿主按事件名把 handler 与事件类型配对，测试里按事件名字面量复原该配对。
		if (event === "before_agent_start") handlers.beforeAgentStart = handler as Handler<BeforeAgentStartEventLike>;
		if (event === "goal_updated") handlers.goalUpdated = handler as Handler<GoalUpdatedEventLike>;
		if (event === "turn_end") handlers.turnEnd = handler as Handler<Record<string, never>>;
	};

	harness.pi = {
		logger: { info: () => {}, warn: () => {} },
		getActiveTools: () => [...tools],
		setActiveTools: async (names: string[]) => {
			setCalls.push([...names]);
			// 模拟宿主门控：goal 工具没被注册时，请求它也不会进入活动集。
			harness.tools.splice(
				0,
				harness.tools.length,
				...names.filter((name) => name !== "goal" || goalToolAvailable),
			);
		},
		on: register,
	} as unknown as ExtensionAPI; // 只实现插件用到的四个成员

	return harness;
}

function ctx(): ExtensionContext {
	// 插件只读 sessionManager.getSessionId()。
	return { sessionManager: { getSessionId: () => "s1" } } as unknown as ExtensionContext;
}

describe("marker", () => {
	test("命中标记行，允许引用前缀与空白差异", () => {
		expect(hasAutoGoalMarker(COMMAND_PROMPT)).toBe(true);
		expect(hasAutoGoalMarker("> omp-auto-goal: on")).toBe(true);
		expect(hasAutoGoalMarker("  omp-auto-goal:on\n后续内容")).toBe(true);
		expect(hasAutoGoalMarker("说明\n> OMP-AUTO-GOAL:  ON \n说明")).toBe(true);
	});

	test("不命中普通文本、关闭值、行内提到与 HTML 注释", () => {
		expect(hasAutoGoalMarker("只是一段说明文字")).toBe(false);
		expect(hasAutoGoalMarker("omp-auto-goal: off")).toBe(false);
		expect(hasAutoGoalMarker("见 omp-auto-goal 插件文档，它按 omp-auto-goal: on 检测")).toBe(false);
		// 宿主在 prompt 渲染阶段会剥掉 HTML 注释，所以注释标记不是有效标记。
		expect(hasAutoGoalMarker("<!-- omp-auto-goal: on -->")).toBe(false);
	});
});

describe("contract", () => {
	test("已挂载时声明来源，且不含未挂载的停止项", () => {
		const text = buildContract({ armed: true });
		expect(text).toContain("已由 omp-auto-goal 挂载");
		expect(text).not.toContain("未挂载");
		expect(text).not.toContain("不要模仿或绕过 goal 模式");
	});

	test("未挂载时带上原因并要求停下，不模仿 goal 模式", () => {
		const text = buildContract({ armed: false, reason: "goal.enabled=false" });
		expect(text).toContain("未挂载：goal.enabled=false");
		expect(text).toContain("不要模仿或绕过 goal 模式");
	});

	test("协议要求先调研，并允许推理充分时跳过访谈", () => {
		const text = buildContract({ armed: true });
		expect(text).toContain("先调研，不要先问");
		expect(text).toContain("跳过访谈");
		expect(text).toContain("进入访谈，只问这些缺项");
		expect(text).toContain("只在用户明确给出 token 预算时");
	});

	test("访谈走一次 ask 批量问，且无头环境不猜不建 goal", () => {
		const text = buildContract({ armed: true });
		expect(text).toContain("一次 `ask` 批量问");
		expect(text).toContain("不要一个回合只问一个问题");
		expect(text).toContain("`ask` 不可用");
		expect(text).toContain("不创建 goal、不猜测");
	});

	test("五段结构按序出现", () => {
		const text = buildContract({ armed: true });
		const positions = FIVE_SECTIONS.map((heading) => text.indexOf(heading));
		expect(positions.every((index) => index >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	});
});

describe("goal tool lifecycle", () => {
	test("带标记的回合挂载 goal 工具并注入协议消息", async () => {
		const h = createHarness(["read", "bash"]);
		ompAutoGoal(h.pi);
		const result = await h.beforeAgentStart({ prompt: COMMAND_PROMPT });

		expect(h.tools).toEqual(["read", "bash", "goal"]);
		expect(result?.message?.customType).toBe("omp-auto-goal");
		expect(result?.message?.content).toContain("已由 omp-auto-goal 挂载");
		expect(result?.message?.attribution).toBe("agent");
	});

	test("无标记的回合不挂载、不注入", async () => {
		const h = createHarness(["read"]);
		ompAutoGoal(h.pi);
		const result = await h.beforeAgentStart({ prompt: "普通的用户消息" });

		expect(result).toBeUndefined();
		expect(h.setCalls).toEqual([]);
		expect(h.tools).toEqual(["read"]);
	});

	test("已处于 goal 模式的会话（如内置 /goal 已挂载）不重复挂载、不注入", async () => {
		const h = createHarness(["read", "goal"]);
		ompAutoGoal(h.pi);
		const result = await h.beforeAgentStart({ prompt: COMMAND_PROMPT });

		expect(result).toBeUndefined();
		expect(h.setCalls).toEqual([]);
		expect(h.tools).toEqual(["read", "goal"]);
	});

	test("宿主基底重试（同一次准备重跑 handler）仍交付契约，turn_end 后不再交付", async () => {
		const h = createHarness(["read"]);
		ompAutoGoal(h.pi);

		// 第一次准备：挂载触发基底变化，宿主会丢弃这条消息并重跑准备。
		const first = await h.beforeAgentStart({ prompt: COMMAND_PROMPT });
		expect(first?.message?.content).toContain("已由 omp-auto-goal 挂载");

		// 重跑：工具已在活动集，但契约尚未落地，必须再交一次。
		const retry = await h.beforeAgentStart({ prompt: COMMAND_PROMPT });
		expect(retry?.message?.customType).toBe("omp-auto-goal");
		expect(h.setCalls).toEqual([["read", "goal"]]);

		await h.turnEnd();

		// 本轮已交付：goal continuation 仍带着含标记的上下文，但不再注入。
		const continuation = await h.beforeAgentStart({ prompt: COMMAND_PROMPT });
		expect(continuation).toBeUndefined();
	});

	test("goal 工具未注册（goal.enabled=false）时保留原工具集并报告原因", async () => {
		const h = createHarness(["read"], false);
		ompAutoGoal(h.pi);
		const result = await h.beforeAgentStart({ prompt: COMMAND_PROMPT });

		expect(h.tools).toEqual(["read"]);
		expect(result?.message?.content).toContain("未挂载：");
		expect(result?.message?.content).toContain("不要模仿或绕过 goal 模式");
	});

	test("goal 完成或暂停时摘掉 goal 工具，active/budget-limited 时不动", async () => {
		const h = createHarness(["read"]);
		ompAutoGoal(h.pi);
		await h.beforeAgentStart({ prompt: COMMAND_PROMPT });
		expect(h.tools).toContain("goal");

		await h.goalUpdated({ state: { enabled: true } });
		expect(h.tools).toContain("goal");

		await h.goalUpdated({ state: { enabled: true }, goal: { status: "budget-limited" } });
		expect(h.tools).toContain("goal");

		await h.goalUpdated({ state: { enabled: false }, goal: { status: "paused" } });
		expect(h.tools).toEqual(["read"]);
	});

	test("没有本扩展挂载过的会话不被动工具集", async () => {
		const h = createHarness(["read"]);
		ompAutoGoal(h.pi);
		await h.goalUpdated({ state: { enabled: false }, goal: { status: "dropped" } });

		expect(h.setCalls).toEqual([]);
		expect(h.tools).toEqual(["read"]);
	});
});
