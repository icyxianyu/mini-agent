/**
 * Web 内容获取工具 — 抓取网页并提取可读文本。
 */
import https from "node:https";
import http from "node:http";
import { ToolBase, ToolResult } from "./base.js";

/** 最大响应体 1MB */
const MAX_BODY = 1_024_000;
/** 请求超时 5s */
const TIMEOUT_MS = 5_000;

export class FetchUrlTool extends ToolBase {
  name = "fetch_url";
  riskLevel = "read" as const;
  description =
    "获取指定 URL 的网页内容，返回提取后的纯文本。" +
    " 用于查阅在线文档、API 参考、技术文章等。" +
    " 仅支持 HTTP/HTTPS，超时 5s，上限 1MB。";
  parameters = {
    type: "object",
    properties: {
      url: { type: "string", description: "要获取的网页 URL（http/https）" },
    },
    required: ["url"],
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const rawUrl = args.url as string;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return ToolResult.fail(`无效 URL: ${rawUrl}`);
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return ToolResult.fail(`不支持的协议: ${url.protocol}，仅支持 http/https`);
    }

    try {
      const html = await this.fetch(url, 0);
      const text = extractText(html);
      return ToolResult.ok(text);
    } catch (e: any) {
      return ToolResult.fail(`获取失败: ${e.message}`);
    }
  }

  /** HTTP(S) GET，支持重定向（最多 3 次） */
  private fetch(url: URL, redirectCount: number): Promise<string> {
    if (redirectCount > 3) {
      return Promise.reject(new Error("重定向次数过多"));
    }

    const mod = url.protocol === "https:" ? https : http;

    return new Promise<string>((resolve, reject) => {
      const req = mod.get(
        url,
        {
          headers: {
            "User-Agent": "MiniAgent/0.1",
            Accept: "text/html,text/plain",
          },
          timeout: TIMEOUT_MS,
        },
        (res) => {
          // 重定向
          if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
            const loc = res.headers.location;
            if (!loc) return reject(new Error(`HTTP ${res.statusCode} 但无 Location 头`));
            try {
              const next = new URL(loc, url);
              return resolve(this.fetch(next, redirectCount + 1));
            } catch {
              return reject(new Error(`无效的重定向地址: ${loc}`));
            }
          }

          if (!res.statusCode || res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }

          const chunks: Buffer[] = [];
          let total = 0;

          res.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_BODY) {
              req.destroy();
              return reject(new Error("响应体超过 1MB 上限"));
            }
            chunks.push(chunk);
          });

          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
          res.on("error", reject);
        },
      );

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("请求超时 (5s)"));
      });
      req.on("error", reject);
    });
  }
}

// ─── HTML → 纯文本 ──────────────────────────────────

/** 需要整块移除的标签 */
const REMOVE_TAGS = /<(script|style|nav|header|footer|iframe|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** 块级标签 → 换行 */
const BLOCK_TAGS = /\n?<\/(?:p|div|section|article|h[1-6]|li|tr|table|pre|blockquote)[^>]*>\n?/gi;
const BR_TAGS = /<br\s*\/?>/gi;

/** 移除剩余 HTML 标签和注释 */
const ANY_TAG = /<[^>]+>/g;
const COMMENT = /<!--[\s\S]*?-->/g;

/** HTML 实体 */
const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
  "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
};

function extractText(html: string): string {
  let text = html;

  // 1. 只取 body（如果有）
  const bodyMatch = text.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) text = bodyMatch[1];

  // 2. 移除 script/style/nav/header/footer
  text = text.replace(REMOVE_TAGS, "");

  // 3. 注释
  text = text.replace(COMMENT, "");

  // 4. 块级标签 → 换行
  text = text.replace(BLOCK_TAGS, "\n");
  text = text.replace(BR_TAGS, "\n");

  // 5. 移除剩余标签
  text = text.replace(ANY_TAG, "");

  // 6. HTML 实体解码
  text = text.replace(/&[#a-z0-9]+;/gi, (m) => ENTITIES[m] ?? m);

  // 7. 压缩空白：连续空行 → 单空行
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  // 8. 截断（保底）
  if (text.length > MAX_BODY) {
    text = text.slice(0, MAX_BODY) + "\n\n(内容已截断，超过 1MB)";
  }

  return text || "(页面无文本内容)";
}
