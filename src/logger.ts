/**
 * Logger 模块 — 记录 Agent 交互过程的完整原始数据。
 *
 * 设计原则:
 * - 原始数据: 不做任何截断、美化、摘要，保留完整内容
 * - 毫秒时间戳: 每条记录精确到毫秒
 * - 结构清晰: 每个事件有明确的分隔标记
 * - 非侵入: 写入失败不影响主流程
 *
 * 记录的事件:
 *   SESSION START    — 会话开始（模型、接口信息）
 *   USER INPUT       — 用户输入的完整文本
 *   LLM REQUEST      — 发送给 LLM 的完整请求（messages + tools）
 *   LLM RESPONSE     — LLM 返回的完整响应（content / tool_calls）
 *   TOOL EXECUTION   — 工具调用参数
 *   TOOL RESULT      — 工具执行结果（成功/失败 + 完整内容）
 *   SYSTEM EVENT     — 会话重置、异常等
 */
import fs from "node:fs";
import path from "node:path";

export class Logger {
  private filePath: string;
  private roundCount = 0;
  /** 当前 round 内 LLM 调用的序号（每个 round 可能多次调 LLM） */
  private callIndexInRound = 0;

  constructor(logDir = "logs") {
    fs.mkdirSync(logDir, { recursive: true });

    const ts = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\..+/, "");
    this.filePath = path.join(logDir, `session-${ts}.log`);
  }

  // ─── 公开方法 ─────────────────────────────────

  /** 会话启动 */
  logSessionStart(model: string, baseUrl: string): void {
    const header = [
      "=".repeat(80),
      `SESSION START — ${this.now()}`,
      `Model: ${model}  |  Base URL: ${baseUrl}`,
      "=".repeat(80),
      "",
    ].join("\n");
    this.write(header);
  }

  /** 会话结束 */
  logSessionEnd(): void {
    this.write(`\n${"=".repeat(80)}\nSESSION END — ${this.now()}\n${"=".repeat(80)}\n`);
  }

  /** 一轮对话开始 */
  logUserInput(input: string): void {
    this.roundCount++;
    this.callIndexInRound = 0;
    this.write(
      `\n${"-".repeat(80)}\n` +
      `[${this.now()}] USER INPUT (Round ${this.roundCount})\n` +
      `${"-".repeat(80)}\n` +
      `${input}\n`
    );
  }

  /**
   * 记录发送给 LLM 的完整请求。
   * 由 llm.ts 中的 chat() 函数调用。
   */
  logLLMRequest(
    messages: Array<{ role: string; content?: string | null; tool_calls?: unknown; tool_call_id?: string }>,
    tools: Array<Record<string, unknown>> | undefined,
  ): void {
    this.callIndexInRound++;

    let content = `${"-".repeat(80)}\n`;
    content += `[${this.now()}] LLM REQUEST (Round ${this.roundCount}, Call ${this.callIndexInRound})\n`;
    content += `${"-".repeat(80)}\n\n`;

    // Messages
    content += "Messages:\n";
    for (const msg of messages) {
      const role = msg.role;
      if (role === "tool") {
        content += `  [${role}]  ← id=${msg.tool_call_id}\n`;
        if (msg.content) {
          content += `    ${this.indent(String(msg.content), "    ")}\n`;
        }
      } else if (msg.tool_calls) {
        content += `  [${role}]  tool_calls:\n`;
        content += `    ${JSON.stringify(msg.tool_calls, null, 2).replace(/\n/g, "\n    ")}\n`;
      } else {
        content += `  [${role}]  ${msg.content ?? "(null)"}\n`;
      }
    }

    // Tools
    content += "\nTools: ";
    if (tools && tools.length > 0) {
      const names = tools.map((t) => (t.function as Record<string, unknown>)?.name ?? "?");
      content += `[${names.join(", ")}]`;
    } else {
      content += "(none)";
    }
    content += "\n";

    this.write(content);
  }

  /**
   * 记录 LLM 返回的完整响应。
   * 由 llm.ts 中的 chat() 函数调用。
   */
  logLLMResponse(
    finishReason: string,
    content: string | null,
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> | null,
  ): void {
    let text = `\n[${this.now()}] LLM RESPONSE (Round ${this.roundCount}, Call ${this.callIndexInRound})\n`;
    text += `Finish Reason: ${finishReason}\n`;

    if (content !== null) {
      text += `Content:\n${content}\n`;
    }

    if (toolCalls && toolCalls.length > 0) {
      text += "Tool Calls:\n";
      for (const tc of toolCalls) {
        text += `  - id: ${tc.id}\n`;
        text += `    name: ${tc.name}\n`;
        text += `    arguments: ${JSON.stringify(tc.arguments, null, 2).replace(/\n/g, "\n    ")}\n`;
      }
    }

    this.write(text);
  }

  /** 工具执行信息 */
  logToolExecution(name: string, args: Record<string, unknown>): void {
    this.write(
      `\n[${this.now()}] TOOL EXECUTION (Round ${this.roundCount})\n` +
      `Tool: ${name}\n` +
      `Arguments: ${JSON.stringify(args, null, 2)}\n`
    );
  }

  /** 工具执行结果 */
  logToolResult(success: boolean, content: string): void {
    this.write(
      `\n[${this.now()}] TOOL RESULT (Round ${this.roundCount})\n` +
      `Success: ${success}\n` +
      `Content:\n${content}\n`
    );
  }

  /** 系统事件 */
  logSystem(message: string): void {
    this.write(`\n[${this.now()}] SYSTEM: ${message}\n`);
  }

  /** 异常 */
  logError(message: string): void {
    this.write(`\n[${this.now()}] ERROR: ${message}\n`);
  }

  /** 获取日志文件路径 */
  getFilePath(): string {
    return this.filePath;
  }

  // ─── 内部方法 ─────────────────────────────────

  /** 当前时间戳（ISO 8601 + 毫秒） */
  private now(): string {
    const d = new Date();
    const iso = d.toISOString(); // "2026-06-06T07:47:00.123Z"
    return iso;
  }

  private write(text: string): void {
    try {
      fs.appendFileSync(this.filePath, text, "utf-8");
    } catch (e) {
      console.error(`[Logger] 写入失败: ${(e as Error).message}`);
    }
  }

  /** 缩进多行文本 */
  private indent(text: string, prefix: string): string {
    return text.split("\n").join("\n" + prefix);
  }
}
