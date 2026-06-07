/**
 * Shell 命令工具 — 允许 Agent 执行终端命令。
 *
 * ┌─────────────────────────────────────────────────────┐
 * │  用户: "帮我初始化一个 React 项目"                    │
 * │    → LLM 决定: execute_command("npx create-react-app")
 * │    → Agent 执行命令，拿到输出                        │
 * │    → LLM 看到输出，告诉用户结果                      │
 * └─────────────────────────────────────────────────────┘
 *
 * 安全设计（学习版，不设沙箱）:
 * - 超时保护: 默认 30 秒，防止挂死
 * - 输出截断: 超过 8000 字符截断，防止撑爆 LLM 上下文
 * - 合并 stderr: stderr 也返回，不少 CLI 工具将正常输出打到 stderr
 * - 工作目录: 默认 process.cwd()，可通过参数指定
 */
import { exec } from "node:child_process";
import { ToolBase, ToolResult } from "./base.js";
import { Config } from "../config.js";

/** 危险命令模式（正则） */
const DANGER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /rm\s+-rf?\s/, label: "递归删除" },
  { pattern: /git\s+push\s+--force/, label: "强制推送" },
  { pattern: /git\s+push\s+-f\b/, label: "强制推送" },
  { pattern: /\bsudo\b/, label: "管理员权限" },
  { pattern: /chmod\s+777/, label: "放宽所有权限" },
  { pattern: />\s*\/dev\//, label: "写入系统设备" },
  { pattern: /mkfs\./, label: "格式化磁盘" },
  { pattern: /dd\s+if=/, label: "磁盘操作" },
  { pattern: /:\(\)\s*\{/, label: "fork 炸弹" },
];

/** 检查命令是否危险，返回危险标签列表 */
export function checkDanger(command: string): string[] {
  return DANGER_PATTERNS
    .filter(p => p.pattern.test(command))
    .map(p => p.label);
}

export class ShellCommandTool extends ToolBase {
  name = "execute_command";
  riskLevel = "execute" as const;
  description =
    "在终端中执行一条命令并返回输出。适用于运行脚本、安装依赖、执行测试、查看 git 状态。" +
    " 需要了解项目状态时直接执行（git status 等），不需要先读文件。安装依赖、构建等有副作用，需用户确认。" +
    " 默认工作目录为项目根目录，超时 30 秒。";

  parameters = {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "要执行的终端命令（如 'ls -la'、'npm install'）",
      },
      working_dir: {
        type: "string",
        description: "命令执行的工作目录，默认为当前目录",
      },
      timeout: {
        type: "integer",
        description: "超时时间（秒），默认 30 秒",
      },
    },
    required: ["command"],
  };

  execute(args: Record<string, unknown>): Promise<ToolResult> {
    const command = args.command as string;
    const workingDir = (args.working_dir as string) || Config.workspaceRoot;
    const timeoutSec = ((args.timeout as number) || 30) * 1000;

    return new Promise((resolve) => {
      const opts: Record<string, unknown> = {
        cwd: workingDir,
        timeout: timeoutSec,
        maxBuffer: 1024 * 1024 * 5, // 5MB 最大缓冲区
      };
      const child = exec(command, opts, (error, stdout, stderr) => {
          const parts: string[] = [];

          // 工作目录
          parts.push(`Working Directory: ${workingDir}`);

          // 退出码
          if (error) {
            const exitCode = (error as any).code ?? "unknown";
            const killed = (error as any).killed;
            if (killed) {
              parts.push(`Exit Code: TIMEOUT (killed after ${(timeoutSec / 1000)}s)`);
            } else {
              parts.push(`Exit Code: ${exitCode}`);
            }
          } else {
            parts.push("Exit Code: 0");
          }

          // stdout
          if (stdout) {
            parts.push("\n--- stdout ---\n" + this.truncate(stdout));
          } else {
            parts.push("\n--- stdout ---\n(empty)");
          }

          // stderr (很多工具把正常信息输出到 stderr)
          if (stderr) {
            parts.push("\n--- stderr ---\n" + this.truncate(stderr));
          }

          const output = parts.join("\n");
          resolve(ToolResult.ok(output));
        },
      );

      // stdin 关闭，避免命令等待输入
      child.stdin?.end();
    });
  }

  /** 截断过长输出，避免撑爆 LLM 上下文 */
  private truncate(text: string, maxLen = 8000): string {
    if (text.length <= maxLen) return text.trimEnd();
    const half = Math.floor(maxLen / 2);
    return (
      text.slice(0, half).trimEnd() +
      `\n\n... (truncated ${text.length - maxLen} chars) ...\n\n` +
      text.slice(-half).trimStart()
    );
  }
}
