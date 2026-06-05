/**
 * 会话管理 — 多会话持久化，按工作区隔离。
 *
 * 目录结构:
 *   .mini-agent/sessions/{workspace-hash}/
 *     session-2026-06-06T18-00-00.json   ← 时间戳命名
 *     session-2026-06-06T17-30-00.json
 *
 * 特性:
 * - 按 WORKSPACE_ROOT 自动隔离不同项目
 * - 每次启动默认开始新会话
 * - 支持 /session 命令切换、列出、新建
 * - 每轮对话后自动保存
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Config } from "./config.js";
import type { Message } from "./core.js";

export interface SessionInfo {
  name: string;      // 文件名
  label: string;     // 展示名
  messageCount: number;
  size: number;      // 字节数
  preview: string;   // 第一条 user 消息的前 60 字符
}

export class SessionManager {
  private dir: string;
  private current: string | null = null;
  private latestMessages: Message[] | null = null; // 内存缓存，autoSave 用

  constructor() {
    const wsHash = crypto.createHash("md5").update(Config.workspaceRoot).digest("hex").slice(0, 8);
    this.dir = path.join(Config.workspaceRoot, ".mini-agent", "sessions", wsHash);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** 开始新会话 */
  startNew(): string {
    const ts = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
    this.current = `session-${ts}.json`;
    return this.current;
  }

  /** 列出所有会话 */
  list(): SessionInfo[] {
    const sessions: SessionInfo[] = [];
    try {
      const files = fs.readdirSync(this.dir).filter(f => f.endsWith(".json")).sort().reverse();
      for (const file of files) {
        const filePath = path.join(this.dir, file);
        const stat = fs.statSync(filePath);
        const preview = this.readPreview(filePath);
        const msgs = this.countMessages(filePath);
        sessions.push({
          name: file,
          label: file.replace("session-", "").replace(".json", "").replace(/T/g, " "),
          messageCount: msgs,
          size: stat.size,
          preview,
        });
      }
    } catch { /* 目录不存在 */ }
    return sessions;
  }

  /** 保存当前会话 */
  save(messages: Message[], name?: string): void {
    const fileName = name ?? this.current;
    if (!fileName) return;
    this.latestMessages = messages;
    try {
      const filePath = path.join(this.dir, fileName);
      fs.writeFileSync(filePath, JSON.stringify(messages, null, 2), "utf-8");
    } catch { /* 保存失败不影响 */ }
  }

  /** 自动保存（每轮对话后调用） */
  autoSave(messages: Message[]): void {
    if (!this.current) return;
    this.save(messages, this.current);
  }

  /** 加载指定会话 */
  load(name: string): Message[] | null {
    try {
      const filePath = path.join(this.dir, name);
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, "utf-8");
      const msgs = JSON.parse(raw);
      if (Array.isArray(msgs) && msgs.length > 0) {
        this.current = name;
        return msgs;
      }
    } catch { /* 损坏 */ }
    return null;
  }

  /** 删除会话 */
  delete(name: string): boolean {
    try {
      const filePath = path.join(this.dir, name);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
      }
    } catch { /* noop */ }
    return false;
  }

  /** 当前会话名 */
  getCurrentName(): string | null {
    return this.current;
  }

  /** 会话目录路径 */
  getDir(): string {
    return this.dir;
  }

  // ─── 内部 ─────────────────────────────────

  private readPreview(filePath: string): string {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const msgs = JSON.parse(raw);
      if (Array.isArray(msgs)) {
        for (const m of msgs) {
          if (m.role === "user" && m.content) {
            return (m.content as string).slice(0, 60).replace(/\n/g, " ");
          }
        }
      }
    } catch { /* noop */ }
    return "(空)";
  }

  private countMessages(filePath: string): number {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const msgs = JSON.parse(raw);
      return Array.isArray(msgs) ? msgs.length : 0;
    } catch { return 0; }
  }
}
