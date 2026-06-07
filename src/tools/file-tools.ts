/**
 * 文件操作工具集 — 8 个文件系统工具。
 *
 * 包含：
 *   read_file       读取文件（支持行范围）
 *   write_file      写入/创建文件
 *   edit_file       搜索替换（精确匹配）
 *   delete_file     删除文件
 *   copy_file       复制文件
 *   move_file       移动/重命名
 *   create_directory  创建目录
 *   list_directory    列出目录内容
 *
 * ┌─────────────┐    ┌──────────────┐
 * │  用户说：     │    │  LLM 决定：    │
 * │ "读一下 xxx" │───▶│ read_file()  │
 * └─────────────┘    └──────┬───────┘
 *                           │ 工具返回结果
 *                           ▼
 *                    LLM 用结果回答用户
 *
 * 用户不需要知道工具名，LLM 会根据自然语言自主判断该调哪个。
 */
import fs from "node:fs";
import path from "node:path";
import { ToolBase, ToolResult } from "./base.js";
import { resolveWorkspacePath } from "./fs-utils.js";

/** 源码文件后缀 */
const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".java", ".go", ".rs", ".c", ".cpp", ".h", ".hpp",
  ".cs", ".rb", ".php", ".swift", ".kt", ".scala", ".clj",
  ".vue", ".svelte", ".astro",
]);

function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTS.has(path.extname(filePath).toLowerCase());
}

// ═══════════════════════════════════════════════════
//  各工具实现
// ═══════════════════════════════════════════════════

export class ReadFileTool extends ToolBase {
  name = "read_file";
  riskLevel = "read" as const;
  description =
    "读取文件内容。使用 search_content 获得行号后，offset 跳到匹配行前 5 行，limit 覆盖匹配行 +10 行（不超过 50）。不要一次读完整个文件。";
  parameters = {
    type: "object",
    properties: {
      file_path: { type: "string", description: "要读取的文件路径" },
      offset: { type: "integer", description: "起始行号（从1开始）" },
      limit: { type: "integer", description: "读取行数" },
    },
    required: ["file_path"],
  };

  execute(args: Record<string, unknown>): ToolResult {
    const filePath = args.file_path as string;
    let resolved: string;
    try { resolved = resolveWorkspacePath(filePath); } catch (e: any) { return ToolResult.fail(e.message); }

    const offset = args.offset as number | undefined;
    const limit = args.limit as number | undefined;
    const DEFAULT_LIMIT = 200; // 无 offset 时默认只返回前 200 行

    if (!fs.existsSync(resolved)) return ToolResult.fail(`文件不存在: ${filePath}`);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return ToolResult.fail(`路径是目录而非文件: ${filePath}`);

    try {
      const raw = fs.readFileSync(resolved, "utf-8");
      const allLines = raw.split("\n");
      const totalLines = allLines.length;

      // 未指定 limit：offset 存在时读余下全部，无 offset 时默认仅前 DEFAULT_LIMIT 行
      const effectiveLimit = limit
        ?? (offset ? Math.max(0, totalLines - (offset - 1)) : Math.min(DEFAULT_LIMIT, totalLines));

      const start = Math.max(0, (offset ?? 1) - 1);
      const lines = allLines.slice(start, start + effectiveLimit);

      const baseLine = offset ?? 1;
      let result = lines
        .map((line, i) => `${String(baseLine + i).padStart(6)}|${line}`)
        .join("\n");

      if (!result) result = "(文件为空)";

      // 如果文件还有更多行，提示剩余行数
      const shownEnd = baseLine + lines.length - 1;
      const remaining = totalLines - shownEnd;
      if (remaining > 0) {
        const nextOffset = shownEnd + 1;
        result += `\n\n（共 ${totalLines} 行，已显示 ${baseLine}-${shownEnd} 行，剩余 ${remaining} 行。使用 offset=${nextOffset} 继续读取。）`;
      }

      // 无 offset 且为源码文件时，追加搜索提示
      if (!offset && isSourceFile(filePath)) {
        result += `\n\n💡 搜索优先：如需定位特定代码，使用 search_content 搜索关键词，再用 offset/limit 精读命中区域。`;
      }

      return ToolResult.ok(result);
    } catch (e: any) {
      return ToolResult.fail(`读取失败: ${e.message}`);
    }
  }
}

export class WriteFileTool extends ToolBase {
  name = "write_file";
  riskLevel = "write" as const;
  description =
    "将内容写入文件。如果文件不存在则创建，如果已存在则覆盖。会自动创建父目录。";
  parameters = {
    type: "object",
    properties: {
      file_path: { type: "string", description: "要写入的文件路径" },
      content: { type: "string", description: "要写入的内容" },
    },
    required: ["file_path", "content"],
  };

  execute(args: Record<string, unknown>): ToolResult {
    const filePath = args.file_path as string;
    const content = args.content as string;
    let resolved: string;
    try { resolved = resolveWorkspacePath(filePath); } catch (e: any) { return ToolResult.fail(e.message); }

    try {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, "utf-8");
      return ToolResult.ok(`文件已写入: ${filePath} (${content.length} 字符)`);
    } catch (e: any) {
      return ToolResult.fail(`写入失败: ${e.message}`);
    }
  }
}

export class EditFileTool extends ToolBase {
  name = "edit_file";
  riskLevel = "write" as const;
  description =
    "在文件中精确查找 old_str 并替换为 new_str。old_str 必须唯一匹配，否则操作失败。";
  parameters = {
    type: "object",
    properties: {
      file_path: { type: "string", description: "要编辑的文件路径" },
      old_str: { type: "string", description: "要替换的原始文本（精确匹配）" },
      new_str: { type: "string", description: "替换后的新文本" },
    },
    required: ["file_path", "old_str", "new_str"],
  };

  execute(args: Record<string, unknown>): ToolResult {
    const filePath = args.file_path as string;
    let resolved: string;
    try { resolved = resolveWorkspacePath(filePath); } catch (e: any) { return ToolResult.fail(e.message); }

    const oldStr = args.old_str as string;
    const newStr = args.new_str as string;

    if (!fs.existsSync(resolved)) return ToolResult.fail(`文件不存在: ${filePath}`);

    try {
      const content = fs.readFileSync(resolved, "utf-8");
      const count = content.split(oldStr).length - 1;
      if (count === 0) return ToolResult.fail("未找到匹配的文本");
      if (count > 1) return ToolResult.fail(`找到 ${count} 处匹配，请提供更精确的 old_str`);

      const newContent = content.replace(oldStr, newStr);
      fs.writeFileSync(resolved, newContent, "utf-8");
      return ToolResult.ok(`文件已编辑: ${filePath}`);
    } catch (e: any) {
      return ToolResult.fail(`编辑失败: ${e.message}`);
    }
  }
}

export class DeleteFileTool extends ToolBase {
  name = "delete_file";
  riskLevel = "delete" as const;
  description = "删除指定文件。操作不可逆，请谨慎使用。";
  parameters = {
    type: "object",
    properties: { file_path: { type: "string", description: "要删除的文件路径" } },
    required: ["file_path"],
  };

  execute(args: Record<string, unknown>): ToolResult {
    const filePath = args.file_path as string;
    let resolved: string;
    try { resolved = resolveWorkspacePath(filePath); } catch (e: any) { return ToolResult.fail(e.message); }

    if (!fs.existsSync(resolved)) return ToolResult.fail(`文件不存在: ${filePath}`);
    try {
      fs.unlinkSync(resolved);
      return ToolResult.ok(`文件已删除: ${filePath}`);
    } catch (e: any) {
      return ToolResult.fail(`删除失败: ${e.message}`);
    }
  }
}

export class CopyFileTool extends ToolBase {
  name = "copy_file";
  riskLevel = "write" as const;
  description = "复制文件到目标路径。会自动创建目标目录。";
  parameters = {
    type: "object",
    properties: {
      source: { type: "string", description: "源文件路径" },
      destination: { type: "string", description: "目标文件路径" },
    },
    required: ["source", "destination"],
  };

  execute(args: Record<string, unknown>): ToolResult {
    const srcStr = args.source as string;
    const dstStr = args.destination as string;
    let src: string, dst: string;
    try { src = resolveWorkspacePath(srcStr); dst = resolveWorkspacePath(dstStr); }
    catch (e: any) { return ToolResult.fail(e.message); }

    if (!fs.existsSync(src)) return ToolResult.fail(`源文件不存在: ${srcStr}`);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      return ToolResult.ok(`文件已复制: ${srcStr} → ${dstStr}`);
    } catch (e: any) {
      return ToolResult.fail(`复制失败: ${e.message}`);
    }
  }
}

export class MoveFileTool extends ToolBase {
  name = "move_file";
  riskLevel = "write" as const;
  description = "移动或重命名文件。会自动创建目标目录。";
  parameters = {
    type: "object",
    properties: {
      source: { type: "string", description: "源文件路径" },
      destination: { type: "string", description: "目标文件路径" },
    },
    required: ["source", "destination"],
  };

  execute(args: Record<string, unknown>): ToolResult {
    const srcStr = args.source as string;
    const dstStr = args.destination as string;
    let src: string, dst: string;
    try { src = resolveWorkspacePath(srcStr); dst = resolveWorkspacePath(dstStr); }
    catch (e: any) { return ToolResult.fail(e.message); }

    if (!fs.existsSync(src)) return ToolResult.fail(`源文件不存在: ${srcStr}`);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      return ToolResult.ok(`文件已移动: ${srcStr} → ${dstStr}`);
    } catch (e: any) {
      return ToolResult.fail(`移动失败: ${e.message}`);
    }
  }
}

export class CreateDirectoryTool extends ToolBase {
  name = "create_directory";
  riskLevel = "write" as const;
  description = "创建目录（包括所有父目录）。";
  parameters = {
    type: "object",
    properties: { path: { type: "string", description: "目录路径" } },
    required: ["path"],
  };

  execute(args: Record<string, unknown>): ToolResult {
    const dirPath = args.path as string;
    let resolved: string;
    try { resolved = resolveWorkspacePath(dirPath); } catch (e: any) { return ToolResult.fail(e.message); }

    try {
      fs.mkdirSync(resolved, { recursive: true });
      return ToolResult.ok(`目录已创建: ${dirPath}`);
    } catch (e: any) {
      return ToolResult.fail(`创建失败: ${e.message}`);
    }
  }
}

export class ListDirectoryTool extends ToolBase {
  name = "list_directory";
  riskLevel = "read" as const;
  description = "列出指定目录下的文件和子目录。";
  parameters = {
    type: "object",
    properties: { path: { type: "string", description: "目录路径" } },
    required: ["path"],
  };

  execute(args: Record<string, unknown>): ToolResult {
    const dirPath = args.path as string;
    let resolved: string;
    try { resolved = resolveWorkspacePath(dirPath); } catch (e: any) { return ToolResult.fail(e.message); }

    if (!fs.existsSync(resolved)) return ToolResult.fail(`目录不存在: ${dirPath}`);
    try {
      const entries = fs
        .readdirSync(resolved, { withFileTypes: true })
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      const lines = entries.map((e) => `  ${e.isDirectory() ? "📁" : "📄"} ${e.name}`);
      return ToolResult.ok(`${dirPath}/\n${lines.join("\n") || "  (空目录)"}`);
    } catch (e: any) {
      return ToolResult.fail(`列出失败: ${e.message}`);
    }
  }
}


