/**
 * 内容搜索工具 — 在项目文件中搜索文本或正则。
 *
 * 优先使用 ripgrep（10~100x 加速），未安装则 fallback 纯 JS。
 * 不排除任何目录（包括 node_modules）——模型自主决定搜索范围，
 * 搜索库源码有助于理解类型定义和 API 用法（对齐 Claude Code 做法）。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ToolBase, ToolResult } from "./base.js";
import { resolveWorkspacePath } from "./fs-utils.js";

export class SearchContentTool extends ToolBase {
  name = "search_content";
  riskLevel = "read" as const;
  description =
    "在指定目录下递归搜索文件内容。返回匹配行、文件路径和行号。" +
    " 回答代码问题时优先使用本工具定位，再根据返回的行号用 read_file 的 offset/limit 精读。" +
    " 根据搜索意图选择合适的 directory：查项目逻辑限定源码目录，查类型定义或库实现时扩大范围。" +
    " 可用 file_types 缩小文件类型。pattern 使用精准关键词或正则，max_results 20~40 足够。";

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

    // 优先 ripgrep，不可用则 fallback 纯 JS
    if (SearchContentTool.hasRipgrep()) {
      return this.executeWithRipgrep(absDir, pattern, fileTypes, caseSensitive, maxResults);
    }
    return this.executeWithJS(absDir, pattern, fileTypes, caseSensitive, maxResults);
  }

  /** ripgrep 快速搜索 */
  private executeWithRipgrep(
    absDir: string, pattern: string, fileTypes: string[] | null,
    caseSensitive: boolean, maxResults: number,
  ): ToolResult {
    const args: string[] = [
      "--no-heading", "--line-number", "--color", "never",
      "--max-count", String(maxResults),
    ];

    if (!caseSensitive) args.push("-i");

    // 文件类型过滤
    if (fileTypes && fileTypes.length > 0) {
      for (const ext of fileTypes) {
        args.push("-g", `*.${ext}`);
      }
    }

    args.push(pattern, absDir);

    try {
      const stdout = execFileSync("rg", args, {
        timeout: 15000,
        maxBuffer: 1024 * 1024, // 1MB
        encoding: "utf-8",
      });
      const lines = stdout.trim().split("\n").filter(Boolean);
      if (lines.length === 0) {
        return ToolResult.ok(`未找到匹配 "${pattern}" 的内容。`);
      }
      const header = `搜索 "${pattern}" 在 ${absDir}/\n匹配 ${lines.length} 条 (ripgrep):\n\n`;
      return ToolResult.ok(header + lines.join("\n"));
    } catch (e: any) {
      // rg 退出码 1 = 无匹配，正常
      if (e.status === 1 && !e.stdout && e.stderr === "") {
        return ToolResult.ok(`未找到匹配 "${pattern}" 的内容。`);
      }
      // 其他错误 → fallback JS
      return this.executeWithJS(absDir, pattern, fileTypes, caseSensitive, maxResults);
    }
  }

  /** 纯 JS fallback 搜索 */
  private executeWithJS(
    absDir: string, pattern: string, fileTypes: string[] | null,
    caseSensitive: boolean, maxResults: number,
  ): ToolResult {
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

  /** 检查系统是否安装了 ripgrep */
  static hasRipgrep(): boolean {
    try {
      execFileSync("rg", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
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
