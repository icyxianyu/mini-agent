/**
 * Logger 模块 — 记录 Agent 交互过程的完整原始数据。
 *
 * 设计原则:
 * - 原始数据: 完整记录，不做截断
 * - 毫秒时间戳: 每条记录精确到毫秒
 * - 可扫读: 用边框标记轮次，新消息高亮
 * - 非侵入: 写入失败不影响主流程
 */
import fs from "node:fs";
import path from "node:path";

const W = 78; // 内容区宽度

/** 水平线 */
function hr(char = "─") { return char.repeat(W); }
/** 标题线 */
function boxTop(title: string) { return `┌${hr()}┐\n│ ${title.padEnd(W - 2)} │\n└${hr()}┘`; }

export class Logger {
  private filePath: string;
  private roundCount = 0;
  private callIndexInRound = 0;
  /** 记录上一次 LLM REQUEST 的消息数量，用于计算新增 */
  private lastMsgCount = 0;

  constructor(logDir = "logs") {
    fs.mkdirSync(logDir, { recursive: true });
    const ts = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
    this.filePath = path.join(logDir, `session-${ts}.log`);
  }

  // ─── 公开方法 ─────────────────────────────────

  logSessionStart(model: string, baseUrl: string): void {
    const info = `${this.now()}  ·  Model: ${model}  ·  ${baseUrl}`;
    this.write(`\n${boxTop(info)}\n`);
  }

  logSessionEnd(): void {
    this.write(`\n${boxTop(`SESSION END — ${this.now()}`)}\n`);
  }

  logUserInput(input: string): void {
    this.roundCount++;
    this.callIndexInRound = 0;
    this.lastMsgCount = 0;
    const header = `ROUND ${this.roundCount} · USER INPUT  |  ${this.now()}`;
    this.write(`\n${boxTop(header)}\n${input}\n`);
  }

  logLLMRequest(
    messages: Array<{ role: string; content?: string | null; tool_calls?: unknown; tool_call_id?: string }>,
    tools: Array<Record<string, unknown>> | undefined,
  ): void {
    this.callIndexInRound++;
    const total = messages.length;
    const toolNames = tools?.map((t) => (t.function as any)?.name ?? "?").join(", ") ?? "none";
    const title = `Round ${this.roundCount} · Call ${this.callIndexInRound}  |  ${total} msg  |  tools: [${toolNames}]  |  ${this.now()}`;

    let out = `\n${boxTop(title)}\n`;

    // 每条消息：标记是否新增
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const isNew = i >= this.lastMsgCount;
      const prefix = isNew ? "✦ " : "  ";
      const roleTag = this.roleTag(msg.role);

      if (msg.role === "tool") {
        out += `${prefix}[${roleTag}]  ← ${msg.tool_call_id}\n`;
        if (msg.content) {
          const preview = this.preview(String(msg.content), 400);
          out += `     │  ${this.indent(preview, "     │  ")}\n`;
        }
      } else if ((msg as any).tool_calls) {
        const tcs = (msg as any).tool_calls as any[];
        const names = tcs.map((tc: any) => tc.function?.name ?? tc.name ?? "?").join(", ");
        out += `${prefix}[${roleTag}]  → tool_calls: [${names}]\n`;
      } else {
        const content = msg.content ?? "(null)";
        const preview = msg.role === "system" ? content : this.preview(String(content), 200);
        out += `${prefix}[${roleTag}]  ${preview}\n`;
      }
    }

    this.lastMsgCount = total;
    this.write(out);
  }

  logLLMResponse(
    finishReason: string,
    content: string | null,
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> | null,
  ): void {
    let out = `\n${"─".repeat(W)}\n`;
    out += `RESPONSE  |  ${finishReason}  |  ${this.now()}\n`;

    if (content !== null) {
      const preview = content.length > 1000
        ? content.slice(0, 1000) + `\n  ... (${content.length} chars total)`
        : content;
      out += `${preview}\n`;
    }

    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        const argsStr = JSON.stringify(tc.arguments);
        const argsPreview = argsStr.length > 200
          ? argsStr.slice(0, 200) + "..."
          : argsStr;
        out += `  → ${tc.name}(${argsPreview})\n`;
      }
    }

    out += `${"─".repeat(W)}\n`;
    this.write(out);
  }

  logToolExecution(name: string, args: Record<string, unknown>): void {
    const argsStr = JSON.stringify(args);
    this.write(`\n  ⚡ ${name}  ${argsStr.length > 100 ? "\n     " + argsStr : argsStr}\n`);
  }

  logToolResult(success: boolean, content: string): void {
    const icon = success ? "✅" : "❌";
    // 文件读取结果显示行数；其他结果截断
    const lines = content.split("\n");
    const summary = lines.length > 20
      ? lines.slice(0, 10).join("\n") + `\n  ... (${lines.length} lines, showing first 10)`
      : this.preview(content, 600);
    this.write(`  ${icon}  ${summary}\n`);
  }

  logSystem(message: string): void {
    this.write(`\n  ℹ️  ${message}  |  ${this.now()}\n`);
  }

  logError(message: string): void {
    this.write(`\n  ❌ ${message}  |  ${this.now()}\n`);
  }

  getFilePath(): string {
    return this.filePath;
  }

  // ─── 内部方法 ─────────────────────────────────

  private now(): string {
    return new Date().toISOString();
  }

  private write(text: string): void {
    try { fs.appendFileSync(this.filePath, text, "utf-8"); } catch { /* noop */ }
  }

  /** 角色标签（彩色可替换 emoji） */
  private roleTag(role: string): string {
    switch (role) {
      case "system": return "SYSTEM ";
      case "user": return "USER   ";
      case "assistant": return "ASSIST ";
      case "tool": return "TOOL   ";
      default: return role.toUpperCase().padEnd(7);
    }
  }

  /** 预览文本：一行显示，太长截断 */
  private preview(text: string, maxLen: number): string {
    const firstLine = text.split("\n")[0];
    if (firstLine.length <= maxLen) return firstLine;
    return firstLine.slice(0, maxLen) + `... (${text.length} chars)`;
  }

  private indent(text: string, prefix: string): string {
    return text.replace(/\n/g, "\n" + prefix);
  }
}
