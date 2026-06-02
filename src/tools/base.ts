/**
 * 工具基类 — 所有工具的抽象接口。
 *
 * ┌─────────────────────────────────────────────────┐
 * │                BaseTool                         │
 * │  · name        — LLM 用来调用此工具的标识符      │
 * │  · description — 帮助 LLM 理解何时使用           │
 * │  · parameters  — JSON Schema 格式的参数定义      │
 * │  · execute()   — 真正执行工具的方法              │
 * └─────────────────────────────────────────────────┘
 *
 * 设计要点：
 * - toOpenAISchema() 将工具定义转为 OpenAI Function Calling 格式
 *   → LLM 通过这个 schema "理解" 工具的用途和参数
 * - execute() 返回 ToolResult {success, content, error}
 *   → Agent 拿到结果后直接拼入消息历史
 * - 新增工具：实现此接口即可，不影响现有代码
 */
import type OpenAI from "openai";

/** 工具执行结果 */
export interface ToolResult {
  success: boolean;
  content: string;
  error?: string;
}

export const ToolResult = {
  ok(content: string): ToolResult {
    return { success: true, content };
  },
  fail(error: string): ToolResult {
    return { success: false, content: "", error };
  },
};

/** 工具接口 — 所有工具必须实现 */
export interface BaseTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;

  /** 转成 OpenAI Function Calling 格式 */
  toOpenAISchema(): OpenAI.Chat.Completions.ChatCompletionTool;

  /** 执行工具 */
  execute(args: Record<string, unknown>): Promise<ToolResult> | ToolResult;
}

/**
 * 工具基类（推荐继承使用）
 * 自动实现 toOpenAISchema()，子类只需定义属性 + execute()
 */
export abstract class ToolBase implements BaseTool {
  abstract name: string;
  abstract description: string;
  abstract parameters: Record<string, unknown>;

  toOpenAISchema(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function" as const,
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters as Record<string, unknown>,
      },
    };
  }

  abstract execute(args: Record<string, unknown>): Promise<ToolResult> | ToolResult;
}
