/**
 * 内容搜索工具 — 在项目文件中搜索文本或正则。
 *
 * 为什么不用 grep：
 * - 跨平台：纯 JS，不依赖系统命令
 * - 自动跳过 node_modules、.git 等
 * - 结果可控：截断上限，格式统一
 * - LLM 友好：看到工具描述直接匹配，不需要"推理出用 grep"
 */
import fs from "node:fs";
import path from "node:path";
import { ToolBase, ToolResult } from "./base.js";
import { resolveWorkspacePath } from "./fs-utils.js";

/** 默认跳过的目录 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".cache",
  "logs",
]);

/** 二进制/大文件后缀，跳过不搜 */
const SKIP_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".tar", ".gz", ".7z",
  ".mp3", ".mp4", ".mov", ".avi",
  ".pdf", ".exe", ".dll", ".so", ".dylib",
  ".lock", // pnpm-lock, yarn.lock, package-lock
]);

export class SearchContentTool extends ToolBase {
  name = "search_content";
  riskLevel = "read" as const;
  description =
    "在指定目录下递归搜索文件内容。" +
    "支持文本匹配和正则表达式。" +
    "自动跳过 node_modules、.git、二进制文件。" +
    "返回匹配行、文件路径和行号。";

  parameters = {
    type: "object",
    properties: {
      directory: {
        type: "string",
        description: "搜索的目录路径（如 'src/' 或 '.'）",
      },
      pattern: {
        type: "string",
        description: "搜索的文本或正则表达式（如 'import.*from' 或 'TODO'）",
      },
      file_types: {
        type: "string",
        description: "逗号分隔，限定文件后缀（如 '.ts,.js'），不填则搜所有文本文件",
      },
      case_sensitive: {
        type: "boolean",
        description: "是否区分大小写，默认 false",
      },
      max_results: {
        type: "integer",
        description: "最大返回条数，默认 50",
      },
    },
    required: ["directory", "pattern"],
  };

  execute(args: Record<string, unknown>): ToolResult {
    const directory = args.directory as string;
    let absDir: string;
    try { absDir = resolveWorkspacePath(directory); } catch (e: any) { return ToolResult.fail(e.message); }

    const pattern = args.pattern as string;
    const fileTypes = args.file_types
      ? (args.file_types as string).split(",").map((s) => s.trim())
      : null;
    const caseSensitive = (args.case_sensitive as boolean) ?? false;
    const maxResults = (args.max_results as number) ?? 50;

    if (!fs.existsSync(absDir)) {
      return ToolResult.fail(`目录不存在: ${directory}`);
    }

    const results: string[] = [];

    try {
      const regex = this.compilePattern(pattern, caseSensitive);
      this.walk(absDir, absDir, regex, fileTypes, results, maxResults);

      if (results.length === 0) {
        return ToolResult.ok(`未找到匹配 "${pattern}" 的内容。`);
      }

      const header = `搜索 "${pattern}" 在 ${absDir}/\n匹配 ${results.length} 条:\n\n`;
      return ToolResult.ok(header + results.join("\n"));
    } catch (e: any) {
      return ToolResult.fail(`搜索失败: ${e.message}`);
    }
  }

  /** 递归遍历目录 */
  private walk(
    rootDir: string,
    currentDir: string,
    regex: RegExp,
    fileTypes: string[] | null,
    results: string[],
    maxResults: number,
  ) {
    if (results.length >= maxResults) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return; // 跳过无权限的目录
    }

    for (const entry of entries) {
      if (results.length >= maxResults) return;

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        this.walk(rootDir, fullPath, regex, fileTypes, results, maxResults);
      } else if (entry.isFile()) {
        this.searchFile(rootDir, fullPath, regex, fileTypes, results, maxResults);
      }
    }
  }

  /** 搜索单个文件 */
  private searchFile(
    rootDir: string,
    filePath: string,
    regex: RegExp,
    fileTypes: string[] | null,
    results: string[],
    maxResults: number,
  ) {
    if (results.length >= maxResults) return;

    const ext = path.extname(filePath).toLowerCase();
    if (SKIP_EXTS.has(ext)) return;
    if (fileTypes && fileTypes.length > 0 && !fileTypes.includes(ext)) return;

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return; // 无法读取（可能是二进制或权限问题）
    }

    const relPath = path.relative(rootDir, filePath);
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      if (results.length >= maxResults) return;

      if (regex.test(lines[i])) {
        // 截断过长的行
        const line = lines[i].length > 200
          ? lines[i].slice(0, 200) + "..."
          : lines[i];
        results.push(`${relPath}:${i + 1}: ${line}`);
      }
    }
  }

  /** 编译搜索模式 */
  private compilePattern(pattern: string, caseSensitive: boolean): RegExp {
    const flags = caseSensitive ? "g" : "gi";
    // 判断是否包含正则特殊字符 — 如果全是普通字符就用字面匹配
    const hasMeta = /[\\^$.*+?()[\]{}|]/.test(pattern);
    const source = hasMeta ? pattern : this.escapeRegex(pattern);
    return new RegExp(source, flags);
  }

  /** 转义正则特殊字符 */
  private escapeRegex(str: string): string {
    return str.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
}
