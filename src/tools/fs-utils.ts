/**
 * 文件系统工具 — 路径校验 & 安全边界。
 *
 * 所有文件类工具的路径都必须经过此模块的 resolveWorkspacePath() 校验，
 * 确保操作不超出 WORKSPACE_ROOT（默认当前目录）。
 */
import path from "node:path";
import { Config } from "../config.js";

/**
 * 解析并校验路径在工作区范围内。
 * 相对路径 → 基于 workspaceRoot 解析
 * 绝对路径 → 检查 prefix 匹配
 *
 * @returns 解析后的绝对路径
 * @throws 路径超出工作区时抛出错误
 */
export function resolveWorkspacePath(filePath: string): string {
  const root = path.resolve(Config.workspaceRoot);
  const resolved = path.resolve(root, filePath);

  // 路径必须在 workspaceRoot 内
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(
      `路径超出工作区: ${filePath}\n工作区: ${root}`
    );
  }

  return resolved;
}

/** 安全解析路径，失败返回 null（不抛异常） */
export function tryResolvePath(filePath: string): string | null {
  try {
    return resolveWorkspacePath(filePath);
  } catch {
    return null;
  }
}
