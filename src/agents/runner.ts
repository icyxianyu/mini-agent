/**
 * 子 Agent 运行器 — 管理子 Agent 的创建、执行、结果收集。
 *
 * 核心职责：
 * 1. 根据 SubAgentConfig 创建子 Agent 实例
 * 2. 处理继承路径（Fork）和独立路径两种委托模式
 * 3. 运行子 Agent 的完整思考-行动循环
 * 4. 收集结构化结果回传给主 Agent
 *
 * ┌──────────────────────────────────────────────────────┐
 * │  SubAgentRunner.run(config, prompt, parentAgent)     │
 * │                                                      │
 * │  delegation === "inherit"                            │
 * │    → clone parent's system prompt + tool schemas     │
 * │    → filter tools based on disallowedTools           │
 * │                                                      │
 * │  delegation === "independent"                        │
 * │    → use agent's own system prompt                   │
 * │    → use restricted tool set                         │
 * │                                                      │
 * │  ┌─── child Agent Loop ───┐                          │
 * │  │  LLM → tool_calls →    │                          │
 * │  │  execute → result →    │ ← 独立 messages 历史     │
 * │  │  LLM → ...             │                          │
 * │  └────────────────────────┘                          │
 * │                                                      │
 * │  → SubAgentResult {status, output, filesModified...} │
 * └──────────────────────────────────────────────────────┘
 */
import { Agent } from "../core.js";
import type { AgentToolSchemas } from "../core.js";
import type { Logger } from "../logger.js";
import { getAllToolSchemas } from "../tools/index.js";
import { checkDanger } from "../tools/shell-tools.js";
import { BUILTIN_AGENTS } from "./builtin.js";
import type {
  SubAgentConfig,
  SubAgentResult,
  SubAgentCallbacks,
} from "./types.js";

/** Runner 构造函数参数 */
export interface RunnerOptions {
  logger: Logger;
  /** 父 Agent 的 tool schemas（继承路径用） */
  parentToolSchemas?: AgentToolSchemas[];
  /** 父 Agent 的 system prompt 内容（继承路径用） */
  parentSystemPrompt?: string;
}

export class SubAgentRunner {
  private readonly logger: Logger;
  private readonly parentToolSchemas?: AgentToolSchemas[];
  private readonly parentSystemPrompt?: string;

  constructor(options: RunnerOptions) {
    this.logger = options.logger;
    this.parentToolSchemas = options.parentToolSchemas;
    this.parentSystemPrompt = options.parentSystemPrompt;
  }

  /**
   * 运行子 Agent
   * @param type - 子 Agent 类型（或任意内置类型的别名）
   * @param prompt - 发送给子 Agent 的任务指令
   * @param callbacks - 进度/流式回调（可选）
   * @returns 结构化执行结果
   */
  async run(
    type: string,
    prompt: string,
    callbacks?: SubAgentCallbacks,
  ): Promise<SubAgentResult> {
    // 1. 解析配置
    const config = this.resolveConfig(type);
    this.logger.logSystem(
      `[SubAgent] 启动子Agent: type=${config.type} delegation=${config.delegation} prompt="${prompt.slice(0, 80)}..."`,
    );

    // 2. 构建带文件追踪 + 危险检测的 askConfirm
    const modifiedFiles = new Set<string>();
    const trackedAskConfirm = async (name: string, args: Record<string, unknown>, risk: string) => {
      this.trackFileModification(name, args, modifiedFiles);
      // 拦截子 Agent 的危险命令（sudo、rm -rf 等）
      if (name === "execute_command") {
        const dangers = checkDanger((args.command as string) ?? "");
        if (dangers.length > 0) {
          this.logger.logSystem(
            `[SubAgent] 拦截危险命令: ${dangers.join(", ")} — ${JSON.stringify(args).slice(0, 100)}`,
          );
          throw new Error(`子Agent 尝试执行危险命令被拦截: ${dangers.join(", ")}。请换用安全方案。`);
        }
      }
      return true;
    };

    // 3. 创建子 Agent（只创建一次）
    const agent = this.createAgent(config, trackedAskConfirm);

    // 4. 执行子 Agent Loop
    const startTime = Date.now();
    let output: string;
    let status: SubAgentResult["status"] = "completed";

    try {
      output = await agent.chat(prompt);
    } catch (e: any) {
      const errMsg = e.message ?? String(e);
      this.logger.logError(`[SubAgent] 子Agent异常: ${errMsg}`);
      output = `子Agent执行异常: ${errMsg}`;
      status = "failed";
    }

    const toolRounds = agent.getRoundCount();
    const elapsed = Date.now() - startTime;
    this.logger.logSystem(
      `[SubAgent] 完成: type=${config.type} status=${status} rounds=${toolRounds} elapsed=${elapsed}ms filesModified=${modifiedFiles.size}`,
    );

    // 5. 收集结构化结果
    const usage = agent.getUsage();
    return {
      status,
      output,
      toolRounds,
      filesModified: [...modifiedFiles],
      tokenUsage: {
        prompt: usage.prompt,
        completion: usage.completion,
      },
    };
  }

  /** 获取某个类型的 System Prompt */
  getSystemPrompt(type: string): string {
    const config = this.resolveConfig(type);
    if (config.delegation === "inherit") {
      return this.parentSystemPrompt ?? "";
    }
    return config.systemPrompt;
  }

  /** 获取某个类型的工具过滤表 */
  getToolFilter(type: string): { allowed: string[]; disallowed: string[] } {
    const config = this.resolveConfig(type);
    return {
      allowed: config.allowedTools,
      disallowed: config.disallowedTools,
    };
  }

  // ─── 内部方法 ───────────────────────────────────────

  /** 解析 Agent 类型，返回配置（兜底 general-purpose） */
  private resolveConfig(type: string): SubAgentConfig {
    // 尝试精确匹配
    if (BUILTIN_AGENTS[type]) return BUILTIN_AGENTS[type];
    // 尝试模糊匹配
    const lower = type.toLowerCase();
    if (BUILTIN_AGENTS[lower]) return BUILTIN_AGENTS[lower];
    // 兜底：general-purpose
    this.logger.logSystem(
      `[SubAgent] 未知类型 "${type}"，使用 general-purpose 兜底`,
    );
    return BUILTIN_AGENTS["general-purpose"];
  }

  /** 创建子 Agent 实例 */
  private createAgent(
    config: SubAgentConfig,
    askConfirm: (name: string, args: Record<string, unknown>, risk: string) => Promise<boolean>,
  ): Agent {
    // 继承路径 Fork：共享父 Agent 的 System Prompt + 工具池
    if (config.delegation === "inherit") {
      const toolSchemas = this.filterToolSchemas(
        this.parentToolSchemas ?? getAllToolSchemas(),
        config,
      );
      return Agent.forked({
        logger: this.logger,
        askConfirm,
        systemPrompt: this.parentSystemPrompt,
        toolSchemas,
        maxToolRounds: config.maxToolRounds,
      });
    }

    // 独立路径：使用 Agent 自己的 System Prompt + 受限工具集
    const toolSchemas = this.filterToolSchemas(getAllToolSchemas(), config);
    return Agent.forked({
      logger: this.logger,
      askConfirm,
      systemPrompt: config.systemPrompt,
      toolSchemas,
      maxToolRounds: config.maxToolRounds,
    });
  }

  /** 按 Agent 配置过滤工具 schema */
  private filterToolSchemas(
    schemas: AgentToolSchemas[],
    config: SubAgentConfig,
  ): AgentToolSchemas[] {
    const disallowed = new Set(config.disallowedTools);

    return schemas.filter((s) => {
      const name = s.function.name;
      // 明确禁止
      if (disallowed.has(name)) return false;
      // "*" 表示全部允许（除明确禁止外）
      if (config.allowedTools.includes("*")) return true;
      // 白名单匹配
      return config.allowedTools.includes(name);
    });
  }

  /** 追踪文件修改 */
  private trackFileModification(
    name: string,
    args: Record<string, unknown>,
    files: Set<string>,
  ): void {
    const fileModifyingTools = [
      "write_file", "edit_file", "delete_file",
      "copy_file", "move_file", "create_directory",
    ];
    if (!fileModifyingTools.includes(name)) return;

    const fileArg = (args.path || args.sourcePath || args.targetPath) as string;
    if (fileArg) {
      files.add(fileArg);
    }
  }
}
