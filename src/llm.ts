/**
 * LLM 客户端 — 封装与大语言模型的交互。
 *
 * 核心概念：LLM 回复有两种形态
 * ┌────────────────────────────────────────────┬────────────────────┐
 * │  文本回复 (TextResponse)                    │  工具调用 (ToolCall)│
 * │  LLM 直接回答用户问题                       │  LLM 请求执行工具   │
 * │  例："main.py 的内容是..."                  │  例：read_file()   │
 * └────────────────────────────────────────────┴────────────────────┘
 *
 * 设计要点：
 * - 使用 OpenAI SDK 的 chat.completions 接口（兼容绝大多数 LLM 厂商）
 * - 启用 function calling 让 LLM 自主决策是否调用工具
 * - 可注入 Logger，记录完整的原始请求/响应数据
 * - chatStream() 支持流式输出，逐 token 回调 onToken
 */
import OpenAI from "openai";
import { Config } from "./config.js";
import type { Logger } from "./logger.js";

// ─── 类型定义 ───────────────────────────────────────

/** LLM 请求调用的一个工具 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** LLM 的统一回复 */
export interface LLMResponse {
  /** 纯文本回复（如果是工具调用则为 null） */
  content: string | null;
  /** 工具调用列表（如果是文本回复则为空） */
  toolCalls: ToolCall[];
}

// ─── LLM 客户端 ─────────────────────────────────────

const client = new OpenAI({
  apiKey: Config.apiKey,
  baseURL: Config.baseUrl,
});

/** chat() 的参数 */
export interface ChatOptions {
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  logger?: Logger;
}

/** chatStream() 的参数 */
export interface ChatStreamOptions extends ChatOptions {
  /** 每收到一个文本 token 时回调 */
  onToken?: (text: string) => void;
}

/**
 * 非流式对话（用于保底总结等短回复场景）
 */
export async function chat(options: ChatOptions): Promise<LLMResponse> {
  const { messages, tools, logger } = options;

  if (logger) {
    logger.logLLMRequest(
      messages.map((m) => ({
        role: m.role,
        content: m.content,
        tool_calls: "tool_calls" in m ? (m as any).tool_calls : undefined,
        tool_call_id: "tool_call_id" in m ? (m as any).tool_call_id : undefined,
      })),
      tools as Array<Record<string, unknown>> | undefined,
    );
  }

  const response = await client.chat.completions.create({
    model: Config.model,
    messages,
    temperature: 0.7,
    ...(tools ? { tools, tool_choice: "auto" } : {}),
  });

  const choice = response.choices[0];
  const msg = choice.message;

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    const toolCalls: ToolCall[] = [];
    for (const tc of msg.tool_calls) {
      try {
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments),
        });
      } catch {
        // LLM 返回了不完整/格式错误的 JSON → 作为错误提不
        if (logger) logger.logLLMResponse(choice.finish_reason, null, toolCalls);
        return {
          content: `❌ 工具调用参数格式错误，请用有效的 JSON 重试。\n工具: ${tc.function.name}\n收到: ${tc.function.arguments.slice(0, 200)}`,
          toolCalls: [],
        };
      }
    }
    if (logger) logger.logLLMResponse(choice.finish_reason, null, toolCalls);
    return { content: null, toolCalls };
  }

  const content = msg.content ?? "";
  if (logger) logger.logLLMResponse(choice.finish_reason, content, null);
  return { content, toolCalls: [] };
}

// ─── 流式对话 ───────────────────────────────────────

/**
 * 流式对话 — 逐 token 回调，支持 tool_calls 碎片拼装。
 *
 * 流式 tool_calls 的难点：
 * OpenAI 流式返回时，tool_calls.arguments 是分片（fragment）来的：
 *   chunk1: arguments = '{"file'
 *   chunk2: arguments = '_path":'
 *   chunk3: arguments = '"src/index.ts"}'
 * 必须在 for await 结束后手动拼接成完整 JSON 再 parse。
 */
export async function chatStream(options: ChatStreamOptions): Promise<LLMResponse> {
  const { messages, tools, logger, onToken } = options;

  if (logger) {
    logger.logLLMRequest(
      messages.map((m) => ({
        role: m.role,
        content: m.content,
        tool_calls: "tool_calls" in m ? (m as any).tool_calls : undefined,
        tool_call_id: "tool_call_id" in m ? (m as any).tool_call_id : undefined,
      })),
      tools as Array<Record<string, unknown>> | undefined,
    );
  }

  const stream = await client.chat.completions.create({
    model: Config.model,
    messages,
    temperature: 0.7,
    ...(tools ? { tools, tool_choice: "auto" } : {}),
    stream: true, // ← 开启流式
  });

  let fullContent = "";
  let finishReason = "stop";

  // 流式 tool_calls 需要跨 chunk 累积
  // key = tool_call index（OpenAI 在 delta.tool_calls[].index 中提供）
  const tcAccum: Map<number, { id: string; name: string; args: string }> = new Map();

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

    // 累积 finish_reason（最后一个有效的 chunk 会带）
    if (chunk.choices[0]?.finish_reason) {
      finishReason = chunk.choices[0].finish_reason;
    }

    // 文本 token → 回调
    if (delta.content) {
      fullContent += delta.content;
      onToken?.(delta.content);
    }

    // tool_calls 碎片 → 累积
    if (delta.tool_calls) {
      for (const dtc of delta.tool_calls) {
        const idx = dtc.index;
        const cur = tcAccum.get(idx) ?? { id: "", name: "", args: "" };

        if (dtc.id) cur.id = dtc.id;
        if (dtc.function?.name) cur.name += dtc.function.name;
        if (dtc.function?.arguments) cur.args += dtc.function.arguments;

        tcAccum.set(idx, cur);
      }
    }
  }

  // 拼接完毕 → 判断是文本还是工具调用
  if (tcAccum.size > 0) {
    const toolCalls: ToolCall[] = [];
    for (const tc of tcAccum.values()) {
      try {
        toolCalls.push({
          id: tc.id,
          name: tc.name,
          arguments: JSON.parse(tc.args),
        });
      } catch {
        // LLM 流式返回的 tool_calls 碎片拼出来不是有效 JSON
        if (logger) logger.logLLMResponse(finishReason, null, toolCalls);
        return {
          content: `❌ 工具调用参数格式错误，请用有效的 JSON 重试。\n工具: ${tc.name}\n拼装后: ${tc.args.slice(0, 200)}`,
          toolCalls: [],
        };
      }
    }
    if (logger) logger.logLLMResponse(finishReason, null, toolCalls);
    return { content: null, toolCalls };
  }

  if (logger) logger.logLLMResponse(finishReason, fullContent, null);
  return { content: fullContent, toolCalls: [] };
}
