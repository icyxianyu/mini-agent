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

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export class Agent {
  /** 对话历史 */
  private messages: Message[] = [];

  /** 工具 schema（传给 LLM） */
  private readonly toolSchemas = getAllToolSchemas();

  /** 日志记录器 */
  private readonly logger: Logger;

  /** 流式文本回调（每收到一个 token 调用一次） */
  private readonly onToken?: (text: string) => void;

  constructor(logger: Logger, onToken?: (text: string) => void) {
    this.logger = logger;
    this.onToken = onToken;
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
      const err = `错误: 未知工具 '${name}'`;
      this.logger.logToolResult(false, err);
      return err;
    }

    console.log(`\n  🔧 调用工具: ${name}(${JSON.stringify(args)})`);

    try {
      const result = await tool.execute(args);
      const resultStr = result.success
        ? result.content
        : `工具执行失败: ${result.error}`;
      this.logger.logToolResult(result.success, resultStr);
      return resultStr;
    } catch (e: any) {
      const err = `工具执行异常: ${e.message}`;
      this.logger.logToolResult(false, err);
      return err;
    }
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
    this.messages = [
      { role: "system", content: Config.systemPrompt },
    ];
    this.logger.logSystem("对话已重置");
  }
}
