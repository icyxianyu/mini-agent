/**
 * Agent 核心循环 — 编排 LLM 思考与工具执行的"大脑中枢"。
 *
 * ┌─────────────────────────────────────────────────────┐
 * │              Agent Loop 流程图                       │
 * │                                                     │
 * │  用户输入 ──▶ LLM.chat(messages, tools, logger)     │
 * │                  │                                  │
 * │          ┌───────┴───────┐                          │
 * │          ▼               ▼                          │
 * │     文本回复           toolCalls                     │
 * │          │               │                          │
 * │          │         执行工具 → 结果加入 messages       │
 * │          │               │                          │
 * │          │         再次发给 LLM（回到顶部）          │
 * │          ▼               ▼                          │
 * │     输出给用户 ←────────────────┘                   │
 * │                                                     │
 * └─────────────────────────────────────────────────────┘
 *
 * 关键设计：
 * 1. "思考→行动→再思考" 循环 — Agent 模式的核心
 *    LLM 调用工具后，工具结果必须回到 LLM 让它基于结果继续推理。
 *
 * 2. 消息历史维护 — 必须严格符合 OpenAI API 格式：
 *    [assistant: tool_calls] → [tool: result] 必须成对出现
 *
 * 3. MAX_TOOL_ROUNDS 防护 — 防止 LLM 陷入无限循环
 *    （比如反复读取同一文件，或工具返回错误后死循环重试）
 */
import type OpenAI from "openai";
import { Config } from "./config.js";
import { chat, chatStream, type LLMResponse } from "./llm.js";
import { getTool, getAllToolSchemas } from "./tools/index.js";
import type { Logger } from "./logger.js";
import type { ProjectContext } from "./context.js";

export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export class Agent {
  /** 对话历史 */
  private messages: Message[] = [];

  /** 工具 schema（传给 LLM） */
  private readonly toolSchemas = getAllToolSchemas();

  /** 日志记录器 */
  private readonly logger: Logger;

  /** 流式文本回调（每收到一个 token 调用一次） */
  private readonly onToken?: (text: string) => void;

  /** 项目上下文（上下文注入用） */
  private readonly context: ProjectContext | null = null;

  /** 工具确认回调（返回 true=允许, false=拒绝） */
  private readonly askConfirm?: (name: string, args: Record<string, unknown>, risk: string) => Promise<boolean>;

  constructor(
    logger: Logger,
    onToken?: (text: string) => void,
    context?: ProjectContext,
    askConfirm?: (name: string, args: Record<string, unknown>, risk: string) => Promise<boolean>,
  ) {
    this.logger = logger;
    this.onToken = onToken;
    this.context = context ?? null;
    this.askConfirm = askConfirm;
    this.reset();
  }

  /** 处理一次用户输入，返回最终回复 */
  async chat(userInput: string): Promise<string> {
    // 1. 用户消息加入历史
    this.messages.push({ role: "user", content: userInput });
    this.logger.logUserInput(userInput);

    // 2. Agent Loop：不断调用 LLM，直到它不再请求工具
    for (let round = 0; round < Config.maxToolRounds; round++) {
      const response = await chatStream({
        messages: this.messages,
        tools: this.toolSchemas,
        logger: this.logger,
        onToken: this.onToken, // ← 流式回调：逐字输出到终端
      });

      // 情况A: 纯文本回复 → 结束
      if (response.toolCalls.length === 0) {
        const reply = response.content ?? "";

        // 如果是工具调用参数格式错误 → 不结束，注入错误提示让 LLM 重试
        if (reply.startsWith("❌ 工具调用参数格式错误")) {
          this.logger.logError("LLM 返回了格式错误的 tool_call 参数，正在重试");
          this.messages.push({
            role: "user",
            content: `${reply}\n\n请修正参数格式后重新调用工具。`,
          });
          continue; // ← 回到循环顶部，重试
        }

        this.messages.push({ role: "assistant", content: reply });
        return reply;
      }

      // 情况B: LLM 请求调用工具 → 并行执行
      this.messages.push(this.formatToolCallsMessage(response));

      const results = await Promise.all(
        response.toolCalls.map(async (tc) => {
          this.logger.logToolExecution(tc.name, tc.arguments);
          const content = await this.executeTool(tc.name, tc.arguments);
          return { id: tc.id, content };
        }),
      );

      for (const r of results) {
        this.messages.push({
          role: "tool",
          tool_call_id: r.id,
          content: r.content,
        });
      }
    }

    // 达到最大轮数 → 强制总结（非流式，短回复用不着流）
    this.logger.logError("达到最大工具调用轮数，强制 LLM 总结");
    this.messages.push({
      role: "user",
      content: "请基于已完成的操作给出最终回复。",
    });
    const final = await chat({
      messages: this.messages,
      logger: this.logger,
    });
    const reply = final.content ?? "已达到最大操作轮数。";
    this.messages.push({ role: "assistant", content: reply });
    return reply;
  }

  /** 执行工具并返回结果字符串 */
  private async executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const tool = getTool(name);
    if (!tool) {
      const err = `❌ 未知工具: ${name}`;
      this.logger.logToolResult(false, err);
      return err;
    }

    // 工具确认：写/删/执行类操作需用户确认
    if (Config.enableToolConfirmation && this.askConfirm && tool.riskLevel !== "read") {
      const approved = await this.askConfirm(name, args, tool.riskLevel);
      if (!approved) {
        const err = `🚫 用户拒绝了工具调用: ${name} —— 请换一种方式或跳过此步骤`;
        this.logger.logToolResult(false, err);
        return err;
      }
    }

    console.log(`\n  🔧 调用工具: ${name}(${JSON.stringify(args)})`);

    try {
      const result = await tool.execute(args);
      if (result.success) {
        this.logger.logToolResult(true, result.content);
        return result.content;
      }

      // 失败 → 结构化错误，引导 LLM 恢复
      const err = this.formatError(name, args, result.error ?? "未知错误");
      this.logger.logToolResult(false, err);
      return err;
    } catch (e: any) {
      const err = this.formatError(name, args, e.message);
      this.logger.logToolResult(false, err);
      return err;
    }
  }

  /** 格式化工具错误，帮助 LLM 理解并自动恢复 */
  private formatError(name: string, args: Record<string, unknown>, msg: string): string {
    const argsPreview = JSON.stringify(args).slice(0, 150);
    // 分类错误，给出针对性提示
    let hint = "";
    if (msg.includes("不存在") || msg.includes("not found") || msg.includes("ENOENT")) {
      hint = `\n💡 提示: 文件/目录不存在，请检查路径是否正确。可用 list_directory 确认目录内容，或用 search_content 搜索文件名。`;
    } else if (msg.includes("权限") || msg.includes("permission") || msg.includes("EACCES")) {
      hint = `\n💡 提示: 权限不足，请尝试其他路径或检查文件权限。`;
    } else if (msg.includes("timed out") || msg.includes("timeout") || msg.includes("killed")) {
      hint = `\n💡 提示: 命令超时，请尝试拆分命令、减少范围或增加 timeout 参数。`;
    }
    return `❌ ${name}(${argsPreview}) 失败: ${msg}${hint}`;
  }

  /** 将 LLMResponse.toolCalls 转成 OpenAI 格式的 assistant 消息 */
  private formatToolCallsMessage(response: LLMResponse): Message {
    return {
      role: "assistant",
      content: null,
      tool_calls: response.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      })),
    };
  }

  /** 重置对话历史 */
  reset(): void {
    this.messages = [this.buildSystemMessage()];
    this.logger.logSystem("对话已重置");
    if (this.context) {
      this.logger.logSystem(`上下文已注入 (${this.context.summary.length} 字符)`);
    }
  }

  /** 构建 system message */
  private buildSystemMessage(): Message {
    let content = Config.systemPrompt;
    if (Config.enableContextInjection && this.context) {
      content += `\n\n## 当前项目上下文\n${this.context.summary}\n\n当用户提出与当前项目相关的需求时，利用以上上下文信息来辅助决策。`;
    }
    return { role: "system", content };
  }

  /** 获取所有消息（供 SessionManager 持久化用） */
  getMessages(): Message[] {
    return this.messages;
  }

  /** 设置消息（从 SessionManager 恢复时用） */
  setMessages(msgs: Message[]): void {
    if (Array.isArray(msgs) && msgs.length > 0) {
      msgs[0] = this.buildSystemMessage(); // 替换为最新上下文
    }
    this.messages = msgs;
  }
}
