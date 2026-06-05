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

export class ShellCommandTool extends ToolBase {
  name = "execute_command";
  riskLevel = "execute" as const;
  description =
    "在终端中执行一条命令并返回输出。" +
    "适用于: 运行构建脚本、安装依赖、执行测试、查看 git 状态等。" +
    "注意: 命令在子进程中执行，默认工作目录为当前项目目录，超时时间 30 秒。";

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
