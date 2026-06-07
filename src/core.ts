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
import { encodeChat } from "gpt-tokenizer";
import { Config } from "./config.js";
import { chat, chatStream, type LLMResponse, type ToolCall } from "./llm.js";
import { getTool, getAllToolSchemas } from "./tools/index.js";
import type { Logger } from "./logger.js";
import type { ProjectContext } from "./context.js";

export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const THRESHOLD = 0.8; // 超 80% 触发裁剪
const KEEP_ROUNDS = 5; // 保留最近 N 轮

/**
 * 精确 token 计数。使用 gpt-tokenizer 的 encodeChat，
 * 会计算 OpenAI chat 格式中自动注入的特殊 token（每条消息的 role 标记等），
 * 比字符数/4 准确得多。DeepSeek 使用 cl100k_base 类似编码，用 'gpt-4' 模型参数即可。
 */
function estimateTokens(messages: Message[]): number {
  // 过滤内容中的 OpenAI 特殊 token（否则 encodeChat 会报 Disallowed special token）
  const sanitize = (s: string) => s.replace(/<\|im_start\|>/g, "[im_start]").replace(/<\|im_end\|>/g, "[im_end]");
  const simplified = messages.map((m) => ({
    role: m.role as "system" | "user" | "assistant" | "function",
    content: sanitize(
      typeof m.content === "string" ? m.content
      : Array.isArray(m.content) ? JSON.stringify(m.content)
      : (m as any).tool_calls ? JSON.stringify((m as any).tool_calls)
      : "",
    ),
  }));
  return encodeChat(simplified, "gpt-4").length;
}

/** 将消息按"用户输入 → 下一用户输入前"拆分为轮次（不包含 system） */
function splitRounds(messages: Message[]): Message[][] {
  const rounds: Message[][] = [];
  let current: Message[] = [];
  let started = false;

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "user" && started) {
      rounds.push(current);
      current = [];
    }
    started = true;
    current.push(msg);
  }
  if (current.length > 0) rounds.push(current);

  return rounds;
}

export class Agent {
  /** 对话历史 */
  private messages: Message[] = [];

  /** 工具 schema（传给 LLM） */
  private readonly toolSchemas = getAllToolSchemas();

  /** 日志记录器 */
  private readonly logger: Logger;

  /** 会话累计 token 用量 */
  private totalUsage = { prompt: 0, completion: 0 };

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
    // 1. 上下文窗口管理：基于已完成的对话，超 80% 上限时裁剪旧轮次
    await this.compressHistory();

    // 2. 用户消息加入历史
    this.messages.push({ role: "user", content: userInput });
    this.logger.logUserInput(userInput);

    // 3. Agent Loop：不断调用 LLM，直到它不再请求工具
    for (let round = 0; round < Config.maxToolRounds; round++) {
      const response = await chatStream({
        messages: this.messages,
        tools: this.toolSchemas,
        logger: this.logger,
        onToken: this.onToken,
      });

      // 累计 token
      if (response.usage) {
        this.totalUsage.prompt += response.usage.prompt;
        this.totalUsage.completion += response.usage.completion;
      }

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

      // 情况B: LLM 请求调用工具
      this.messages.push(this.formatToolCallsMessage(response));

      // 有需要确认的工具时串行执行（避免多个 rl.question 冲突）
      const needsConfirm = Config.enableToolConfirmation && this.askConfirm
        && response.toolCalls.some((tc) => {
          const tool = getTool(tc.name);
          return tool && tool.riskLevel !== "read";
        });

      const execResults = new Map<string, string>();
      if (needsConfirm) {
        const results = await this.executeToolsSerially(response.toolCalls);
        for (const r of results) execResults.set(r.id, r.content);
      } else {
        const settled = await Promise.allSettled(
          response.toolCalls.map(async (tc) => {
            this.logger.logToolExecution(tc.name, tc.arguments);
            const content = await this.executeTool(tc.name, tc.arguments);
            return { id: tc.id, content };
          }),
        );
        for (const s of settled) {
          if (s.status === "fulfilled") execResults.set(s.value.id, s.value.content);
          else this.logger.logError(`工具执行异常: ${s.reason?.message ?? s.reason}`);
        }
      }

      // 确保每个 tool_call_id 都有对应的 tool 消息（API 强制要求）
      for (const tc of response.toolCalls) {
        this.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: execResults.get(tc.id) ?? `❌ 工具 ${tc.name} 执行中断: ${tc.id}`,
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
    if (final.usage) {
      this.totalUsage.prompt += final.usage.prompt;
      this.totalUsage.completion += final.usage.completion;
    }
    const reply = final.content ?? "已达到最大操作轮数。";
    this.messages.push({ role: "assistant", content: reply });
    return reply;
  }

  /** 执行工具并返回结果字符串 */
  private async executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const argsPreview = JSON.stringify(args).slice(0, 80);
    const tool = getTool(name);
    if (!tool) {
      const err = `❌ 未知工具: ${name}`;
      this.logger.logToolResult(false, err);
      console.log(`  ✗ ${name}  未知工具  ${argsPreview}`);
      return err;
    }

    // 工具确认：写/删/执行类操作需用户确认
    if (Config.enableToolConfirmation && this.askConfirm && tool.riskLevel !== "read") {
      const approved = await this.askConfirm(name, args, tool.riskLevel);
      if (!approved) {
        const err = `🚫 用户拒绝了工具调用: ${name} —— 请换一种方式或跳过此步骤`;
        this.logger.logToolResult(false, err);
        console.log(`  ✗ ${name}  已拒绝  ${argsPreview}`);
        return err;
      }
    }

    // 流式进度：显示执行状态
    console.log(`  ⏳ ${name} ${argsPreview}`);

    try {
      const result = await tool.execute(args);
      if (result.success) {
        this.logger.logToolResult(true, result.content);
        console.log(`  ✓ ${name} ${argsPreview}`);
        return result.content;
      }

      // 失败 → 结构化错误，引导 LLM 恢复
      const err = this.formatError(name, args, result.error ?? "未知错误");
      this.logger.logToolResult(false, err);
      console.log(`  ✗ ${name}  失败  ${argsPreview}`);
      return err;
    } catch (e: any) {
      const err = this.formatError(name, args, e.message);
      this.logger.logToolResult(false, err);
      console.log(`  ✗ ${name}  异常  ${argsPreview}`);
      return err;
    }
  }

  /** 串行执行工具（有确认需求时使用，避免 rl.question 冲突） */
  private async executeToolsSerially(toolCalls: ToolCall[]): Promise<{ id: string; content: string }[]> {
    const results: { id: string; content: string }[] = [];
    for (const tc of toolCalls) {
      try {
        this.logger.logToolExecution(tc.name, tc.arguments);
        const content = await this.executeTool(tc.name, tc.arguments);
        results.push({ id: tc.id, content });
      } catch (e: any) {
        this.logger.logError(`工具 ${tc.name} 执行异常: ${e.message}`);
        results.push({ id: tc.id, content: `❌ 工具 ${tc.name} 执行异常: ${e.message}` });
      }
    }
    return results;
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

  /** 上下文窗口管理：超 80% 上限时逐步裁剪旧轮次 */
  private async compressHistory(): Promise<void> {
    const limit = Config.modelContextLimit;
    const estimated = estimateTokens(this.messages);

    if (estimated < limit * THRESHOLD) return;
    if (this.messages.length <= 1) return; // 只有 system，无需裁剪

    const systemMsg = this.messages[0];
    const rounds = splitRounds(this.messages);

    if (rounds.length <= 1) return;

    let keepCount = Math.min(KEEP_ROUNDS, rounds.length - 1);
    this.logger.logSystem(
      `上下文超标: 估算 ${estimated} tokens / ${limit} (${rounds.length} 轮) → 尝试压缩保留 ${keepCount} 轮`,
    );

    // 尝试 LLM 摘要：失败则回退到简单截断
    const { summary, success } = await this.trySummarize(rounds, keepCount);
    if (!success) {
      // 摘要失败 → 直接截断到保留轮次
      const keepRounds = rounds.slice(-keepCount);
      this.messages = [systemMsg, ...keepRounds.flat()];
      this.logger.logSystem(`摘要失败，回退到简单截断: 保留 ${keepCount} 轮`);
      return;
    }

    // 重建消息：system + 摘要 + 保留轮次
    const keepRounds = rounds.slice(-keepCount);
    this.messages = [
      systemMsg,
      { role: "user", content: `[对话历史摘要]\n${summary}` },
      { role: "assistant", content: "已了解对话背景。" },
      ...keepRounds.flat(),
    ];

    const newEstimated = estimateTokens(this.messages);
    this.logger.logSystem(
      `上下文已压缩: ${rounds.length} 轮 → 保留 ${keepCount} 轮 + 摘要 (${summary.length} 字符)` +
        ` | 估算 ${estimated}→${newEstimated} tokens`,
    );

    // 压缩后验证：仍超标则减少保留轮次
    while (newEstimated >= limit * THRESHOLD && keepCount > 1) {
      keepCount--;
      const tighterKeep = rounds.slice(-keepCount);
      this.messages = [
        systemMsg,
        { role: "user", content: `[对话历史摘要]\n${summary}` },
        { role: "assistant", content: "已了解对话背景。" },
        ...tighterKeep.flat(),
      ];
      this.logger.logSystem(
        `压缩后仍超标，减少保留轮次: ${keepCount + 1} → ${keepCount} | 估算 ${estimateTokens(this.messages)} tokens`,
      );
    }

    // 最终兜底：只剩 1 轮仍超标 → 硬截断该轮
    if (estimateTokens(this.messages) >= limit * THRESHOLD && keepCount === 1) {
      const lastRound = rounds[rounds.length - 1];
      const head = lastRound.slice(0, 5);
      const tail = lastRound.slice(-3);
      this.messages = [systemMsg, ...head, ...tail];
      this.logger.logSystem(
        `硬截断: 仍超标，暴击截断最后一轮 (${lastRound.length} → ${head.length + tail.length} 条消息)`,
      );
    }
  }

  /** 尝试生成对话摘要。返回 { summary, success }，失败时 success=false */
  private async trySummarize(
    rounds: Message[][],
    keepCount: number,
  ): Promise<{ summary: string; success: boolean }> {
    const oldRounds = rounds.slice(0, rounds.length - keepCount);
    if (oldRounds.length === 0) return { summary: "", success: false };

    // 构建摘要输入：保留工具调用链路 + 防嵌套退化
    const oldText = oldRounds.map((r, i) => {
      const userMsg = r.find((m) => m.role === "user");
      const userContent = (userMsg?.content as string) ?? "";

      // 已是压缩摘要 → 原文照搬，避免"摘要的摘要"退化
      if (userContent.startsWith("[对话历史摘要]")) {
        return `历史摘要:\n${userContent}`;
      }

      // 提取工具调用记录
      const toolCalls = r
        .filter((m) => m.role === "assistant" && (m as any).tool_calls)
        .flatMap((m) =>
          ((m as any).tool_calls as any[])?.map((tc: any) => tc.function?.name).filter(Boolean) ?? [],
        );
      const toolText = toolCalls.length > 0 ? `\n  工具调用: ${toolCalls.join(" → ")}` : "";

      // 提取最后一条有文本的 assistant 回复
      const lastAssistant = [...r].reverse().find(
        (m) => m.role === "assistant" && (m as any).content,
      );
      const assistantText = (lastAssistant as any)?.content
        ? ((lastAssistant as any).content as string).slice(0, 300)
        : "(工具调用)";

      return `轮次${i + 1}:\n  用户: ${userContent.slice(0, 200)}${toolText}\n  助手: ${assistantText}`;
    }).join("\n\n");

    try {
      const summaryResult = await chat({
        messages: [
          {
            role: "user",
            content: `以下是一段对话历史。请用简洁中文汇总关键决策和成果（不超过300字），只输出摘要文本：\n\n${oldText}`,
          },
        ],
        logger: this.logger,
      });
      const summary = (summaryResult.content ?? "").slice(0, 500);
      return { summary, success: true };
    } catch (e: any) {
      this.logger.logError(`摘要生成失败: ${e.message}`);
      return { summary: "", success: false };
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
    this.messages = [this.buildSystemMessage()];
    this.totalUsage = { prompt: 0, completion: 0 };
    this.logger.logSystem("对话已重置");
    if (this.context) {
      this.logger.logSystem(`上下文已注入 (${this.context.summary.length} 字符)`);
    }
  }

  /** 获取累计 token 用量（会话级别） */
  getUsage() {
    return { ...this.totalUsage };
  }

  /** 获取当前上下文窗口占用情况 */
  getContextUsage(): { current: number; limit: number; threshold: number; percent: number } {
    const limit = Config.modelContextLimit;
    const current = estimateTokens(this.messages);
    return {
      current,
      limit,
      threshold: Math.floor(limit * THRESHOLD),
      percent: Math.round((current / limit) * 100),
    };
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
