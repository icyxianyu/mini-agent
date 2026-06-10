/**
 * TaskTool — 子 Agent 委托工具。
 *
 * 将子 Agent 封装为标准的 OpenAI Function Calling 工具，
 * 主 Agent 通过 Function Calling 自主决定何时 spawn 子 Agent。
 *
 * ┌────────────────────────────────────────────────────┐
 * │  主 Agent Loop                                     │
 * │    LLM → "这任务适合交给子Agent"                    │
 * │         → tool_calls: [{name:"task", args:{...}}]  │
 * │              │                                     │
 * │              ▼                                     │
 * │         TaskTool.execute()                         │
 * │              │                                     │
 * │         SubAgentRunner.run()                       │
 * │              │                                     │
 * │         → SubAgentResult → 注入主Agent messages    │
 * └────────────────────────────────────────────────────┘
 *
 * 两种委托路径：
 * - 省略 subagent_type → general-purpose（继承父 Agent 完整能力）
 * - subagent_type: "explore" → 只读探索（继承 + 工具过滤）
 * - subagent_type: "plan" → 独立规划（独立 Prompt + 只读工具）
 */
import { ToolBase, ToolResult } from "./base.js";
import { SubAgentRunner } from "../agents/runner.js";
import type { AgentToolSchemas } from "../core.js";
import type { Logger } from "../logger.js";

/** 父 Agent 上下文供给（TaskTool 的运行时依赖） */
export interface ParentAgentContext {
  systemPrompt: string;
  toolSchemas: AgentToolSchemas[];
}

/** TaskTool 共享状态（用于 Agent 向 TaskTool 注入父上下文） */
export const taskToolState = {
  /** 获取父 Agent 的上下文 */
  parentContext: null as ParentAgentContext | null,
  /** Logger 实例（由主入口设置） */
  logger: null as Logger | null,
};

/** 获取共享状态的 Runner */
function getRunner(): SubAgentRunner | null {
  const state = taskToolState;
  if (!state.logger || !state.parentContext) return null;
  return new SubAgentRunner({
    logger: state.logger,
    parentToolSchemas: state.parentContext.toolSchemas,
    parentSystemPrompt: state.parentContext.systemPrompt,
  });
}

export class TaskTool extends ToolBase {
  name = "task";
  riskLevel = "read" as const;

  description = [
    "启动一个子Agent来处理复杂、独立的任务。子Agent拥有独立的对话上下文，不会污染主Agent的消息历史。",
    "",
    "## 适用场景",
    "- 代码探索与分析（适合 explore 类型）",
    "- 任务规划与分解（适合 plan 类型，返回结构化步骤）",
    "- 大规模重构、多文件操作（适合 general-purpose 类型）",
    "- 任何需要独立上下文、多轮工具调用的复杂任务",
    "",
    "## 子Agent类型",
    "- general-purpose: 完整工具能力，适合代码重构、功能开发",
    "- explore: 只读，适合项目分析、代码搜索、依赖梳理",
    "- plan: 只读 + 规划专用Prompt，适合制定实施计划（返回JSON步骤列表）",
    "",
    "## 参数",
    "- description: 简短描述任务目标（3-5词）",
    "- prompt: 发给子Agent的完整任务指令",
    "- subagent_type: 可选，子Agent类型，默认 general-purpose",
    "",
    "## 最佳实践",
    "- 对代码探索、项目分析等只读任务使用 explore 类型以节省token",
    "- 对需要先规划的任务，先用 plan 类型获取步骤，再逐步用 general-purpose 执行",
    "- 多个独立子任务应并行调用多个 task（LLM会自动并行）",
    "- prompt 要具体明确，指明文件路径、预期输出格式",
  ].join("\n");

  parameters = {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "简短描述任务目标，3-5个词（如：重构用户服务、探索认证模块、规划数据库迁移）",
      },
      prompt: {
        type: "string",
        description: "发给子Agent的完整任务指令。要具体明确，指明文件路径、预期操作、输出格式。",
      },
      subagent_type: {
        type: "string",
        enum: ["general-purpose", "explore", "plan"],
        description: "子Agent类型。省略默认为 general-purpose。explore=只读探索，plan=规划分析，general-purpose=完整能力。",
      },
    },
    required: ["description", "prompt"],
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const description = (args.description as string) ?? "";
    const prompt = (args.prompt as string) ?? "";
    const subagent_type = (args.subagent_type as string) ?? "general-purpose";

    if (!prompt) {
      return ToolResult.fail("prompt 参数不能为空");
    }

    const runner = getRunner();
    if (!runner) {
      return ToolResult.fail("TaskTool 运行时未初始化，父 Agent 上下文不可用");
    }

    if (!taskToolState.logger) {
      return ToolResult.fail("TaskTool 日志器未初始化");
    }

    taskToolState.logger.logSystem(
      `[TaskTool] 主Agent委托子Agent: type=${subagent_type} desc="${description}" prompt="${prompt.slice(0, 100)}..."`,
    );

    try {
      const result = await runner.run(subagent_type, prompt);

      // 如果是 plan 类型，尝试解析 JSON 计划
      let plan: { title: string; steps: { description: string; dependsOn: number[] }[] } | null = null;
      if (subagent_type === "plan") {
        plan = this.tryParsePlanJson(result.output);
      }

      // 终端输出：子 Agent 完成摘要
      this.printSummary(subagent_type, result, plan);

      // 构建结构化响应（回传给主 Agent 的 messages）
      const response = this.formatResult(result, subagent_type, description, plan);

      taskToolState.logger.logSystem(
        `[TaskTool] 子Agent完成: status=${result.status} rounds=${result.toolRounds} filesModified=${result.filesModified.length}`,
      );

      return ToolResult.ok(response);
    } catch (e: any) {
      const errMsg = e.message ?? String(e);
      taskToolState.logger?.logError(`[TaskTool] 子Agent异常: ${errMsg}`);
      return ToolResult.fail(`子Agent异常 (${subagent_type}: ${description}): ${errMsg}`);
    }
  }

  /** 终端输出子 Agent 完成摘要 */
  private printSummary(
    type: string,
    result: { status: string; toolRounds: number; filesModified: string[]; output: string },
    plan: { title: string; steps: { description: string; dependsOn: number[] }[] } | null,
  ) {
    const roundStr = `[${result.toolRounds}轮]`;
    if (type === "plan" && plan) {
      console.log(`  \n  📋 ${plan.title} — ${plan.steps.length}步骤 ${roundStr}`);
      // 展示前 5 个步骤让用户了解计划概要
      const show = plan.steps.slice(0, 5);
      for (const s of show) {
        const deps = s.dependsOn.length > 0 ? ` ← ${s.dependsOn.join(",")}` : "";
        console.log(`    ${s.description.slice(0, 80)}${deps}`);
      }
      if (plan.steps.length > 5) console.log(`    ... 还有 ${plan.steps.length - 5} 个步骤`);
    } else if (result.filesModified.length > 0) {
      console.log(`  ✅ 已修改 ${result.filesModified.length} 个文件 ${roundStr}`);
    } else {
      console.log(`  ✓ 完成 ${roundStr}`);
    }
  }

  /** 尝试从子 Agent 输出中解析 plan JSON */
  private tryParsePlanJson(output: string): { title: string; steps: { description: string; dependsOn: number[] }[] } | null {
    try {
      let jsonStr = output.trim();
      // 去除 markdown 代码块包裹
      const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) jsonStr = fenceMatch[1].trim();
      // 尝试提取花括号块
      const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (braceMatch) jsonStr = braceMatch[0];

      const parsed = JSON.parse(jsonStr);
      const title = parsed.title ?? "";
      const rawSteps = parsed.steps ?? [];
      if (!Array.isArray(rawSteps) || rawSteps.length === 0) return null;

      const steps = rawSteps.map((s: any) => {
        if (typeof s === "string") {
          return { description: s.trim(), dependsOn: [] as number[] };
        }
        return {
          description: (s.description ?? "").trim(),
          dependsOn: Array.isArray(s.dependsOn) ? (s.dependsOn as number[]) : [],
        };
      }).filter((s: { description: string }) => s.description);

      if (steps.length === 0) return null;
      return { title, steps };
    } catch {
      return null;
    }
  }

  /** 格式化子 Agent 结果（回传给主 Agent 的结构化文本） */
  private formatResult(
    result: {
      status: string;
      output: string;
      toolRounds: number;
      filesModified: string[];
      tokenUsage: { prompt: number; completion: number };
    },
    type: string,
    description: string,
    plan?: { title: string; steps: { description: string; dependsOn: number[] }[] } | null,
  ): string {
    const parts: string[] = [];

    parts.push(`## 子Agent 完成 [${type}] ${description}`);
    parts.push(`- 状态: ${result.status}`);
    parts.push(`- 工具调用轮数: ${result.toolRounds}`);
    if (result.filesModified.length > 0) {
      parts.push(`- 修改的文件: ${result.filesModified.join(", ")}`);
    }

    // plan 类型且解析成功 → 结构化展示计划
    if (type === "plan" && plan) {
      parts.push("");
      parts.push(`### 📋 ${plan.title}`);
      parts.push(`共 ${plan.steps.length} 个步骤:\n`);

      // 按依赖分批渲染
      const completed = new Set<number>();
      let batchNum = 0;
      while (completed.size < plan.steps.length) {
        const batch: number[] = [];
        for (let i = 0; i < plan.steps.length; i++) {
          if (completed.has(i)) continue;
          const depsDone = plan.steps[i].dependsOn.every((depId) => completed.has(depId - 1));
          if (depsDone) batch.push(i);
        }
        if (batch.length === 0) {
          // 循环依赖兜底：剩余全加进去
          for (let i = 0; i < plan.steps.length; i++) {
            if (!completed.has(i)) batch.push(i);
          }
        }

        batchNum++;
        const batchLabel = batch.length > 1
          ? `第${batchNum}批（可并行执行）`
          : `第${batchNum}批`;

        parts.push(`**${batchLabel}:**`);
        for (const idx of batch) {
          const s = plan.steps[idx];
          const deps = s.dependsOn.length > 0
            ? ` ← 依赖步骤 ${s.dependsOn.join("、")}`
            : "";
          parts.push(`  ${idx + 1}. ${s.description}${deps}`);
          completed.add(idx);
        }
        parts.push("");
      }

      parts.push("---");
      parts.push("请审查以上计划，确认后回复执行指令（如\"开始执行\"），或提出修改意见。");
      parts.push("如需并行执行无依赖的步骤，请在单次回复中为每步各调用一个 task。");
      return parts.join("\n");
    }

    // 非 plan 类型 → 通用格式化
    parts.push("");
    parts.push("### 执行输出");
    parts.push(result.output);

    return parts.join("\n");
  }
}
