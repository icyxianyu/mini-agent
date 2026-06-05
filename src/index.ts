/**
 * 主入口 — REPL 交互循环。
 *
 * ┌──────────────────────────────────────────────────┐
 * │  启动 → 验证配置 → 创建 Agent → REPL 循环        │
 * │                                                    │
 * │  命令:                                              │
 * │    /help   显示帮助信息                             │
 * │    /reset  重置对话历史                             │
 * │    /exit   退出程序                                 │
 * │                                                     │
 * │  其他输入 → 交给 Agent 处理（自动判断是否需要工具）  │
 * └──────────────────────────────────────────────────┘
 */
import * as readline from "node:readline";
import chalk from "chalk";
import { Config } from "./config.js";
import { Agent } from "./core.js";
import { Logger } from "./logger.js";
import { collectProjectContext } from "./context.js";
import { SessionManager } from "./session.js";

const BANNER = (logPath: string, sessionInfo: string, contextInfo?: string) => `
${chalk.cyan.bold("╔══════════════════════════════════════════╗")}
${chalk.cyan.bold("║        Mini Claude Code - Agent         ║")}
${chalk.cyan.bold("║       简易版 AI 编程助手 (TypeScript)     ║")}
${chalk.cyan.bold("╚══════════════════════════════════════════╝")}

${chalk.dim("命令:")}
  ${chalk.yellow("/help")}      ${chalk.dim("- 显示帮助")}
  ${chalk.yellow("/reset")}     ${chalk.dim("- 重置对话")}
  ${chalk.yellow("/session")}   ${chalk.dim("- 会话管理 (list/load/new/delete)")}
  ${chalk.yellow("/exit")}      ${chalk.dim("- 退出")}

${chalk.dim("📝 日志:")} ${logPath}
${chalk.dim("💬 会话:")} ${sessionInfo}
${contextInfo ? `${chalk.dim("📋 上下文:")} ${contextInfo}` : ""}

${chalk.dim("直接输入需求，Agent 会自动判断是否需要操作文件。")}
`;

const HELP = `
${chalk.bold("会话管理:")}
  ${chalk.yellow("/session list")}    ${chalk.dim("- 列出所有历史会话")}
  ${chalk.yellow("/session new")}     ${chalk.dim("- 保存当前并开始新会话")}
  ${chalk.yellow("/session load N")}  ${chalk.dim("- 切换到第 N 个会话")}
  ${chalk.yellow("/session delete N")}${chalk.dim("- 删除第 N 个会话")}

${chalk.bold("可用功能:")}
  ${chalk.green("对话交流")}  - 直接输入，AI 会回复
  ${chalk.green("读取文件")}  - 说"读一下 xxx 文件"
  ${chalk.green("写入文件")}  - 说"创建一个 xxx 文件"
  ${chalk.green("编辑文件")}  - 说"修改 xxx 中的某段代码"
  ${chalk.green("删除/复制/移动")} - AI 自动选择合适工具
  ${chalk.green("查看目录")}  - 说"列出当前目录"
`;

// ─── REPL ───────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: chalk.blue("👤 你: "),
});

function ask(): Promise<string> {
  return new Promise((resolve) => {
    rl.question(chalk.blue("👤 你: "), (answer) => resolve(answer.trim()));
  });
}

async function main() {
  // 验证配置
  if (!Config.validate()) {
    console.log(chalk.red("请复制 .env.example 为 .env 并填入你的 API Key"));
    process.exit(1);
  }

  // 初始化日志
  const logger = new Logger();
  logger.logSessionStart(Config.model, Config.baseUrl);

  console.log(chalk.dim(`🚀 模型: ${Config.model}`));
  console.log(chalk.dim(`📍 接口: ${Config.baseUrl}\n`));

  // 上下文注入：启动时自动收集项目信息
  let context;
  let contextSummary = chalk.dim("已禁用");
  if (Config.enableContextInjection) {
    console.log(chalk.cyan("📋 正在收集项目上下文..."));
    context = collectProjectContext();
    contextSummary = `${chalk.green("✓")} ${context.summary.split("\n").length} 行, ${context.summary.length} 字符`;

    // 终端展示上下文概览
    console.log(chalk.dim("  ├─ 目录结构: ") + (context.directoryTree.split("\n").length - 1) + " 行");
    if (context.packageInfo) {
      const pkgFirstLine = context.packageInfo.split("\n")[0];
      console.log(chalk.dim("  ├─ ") + pkgFirstLine);
    }
    if (context.gitStatus) {
      const gitFirstLine = context.gitStatus.split("\n")[0];
      console.log(chalk.dim("  └─ Git: ") + gitFirstLine);
    }
    console.log();

    // 日志记录上下文
    logger.logSystem(`上下文注入 - 项目上下文已收集 (${context.summary.length} 字符)`);
    logger.logSystem(`目录: ${context.directoryTree}`);
    if (context.packageInfo) logger.logSystem(`Package: ${context.packageInfo}`);
    if (context.gitStatus) logger.logSystem(`Git: ${context.gitStatus}`);
  } else {
    console.log(chalk.dim("📋 上下文注入已禁用 (ENABLE_CONTEXT_INJECTION=false)\n"));
  }

  // 工具确认回调（写/删/执行等危险操作需用户确认）
  const autoApprove = new Map<string, boolean>(); // name → 是否永久通过
  const askConfirm = async (name: string, args: Record<string, unknown>, risk: string) => {
    if (autoApprove.has(name)) return true;

    const riskIcon = risk === "delete" ? "⚠️ " : risk === "execute" ? "⚡ " : "✏️ ";
    const riskLabel = risk === "delete" ? chalk.red(`${riskIcon}危险`) : risk === "execute" ? chalk.yellow(`${riskIcon}执行`) : chalk.cyan(`${riskIcon}写入`);
    const argsStr = JSON.stringify(args);
    const shortArgs = argsStr.length > 100 ? argsStr.slice(0, 100) + "..." : argsStr;

    const prompt = [
      `\n  ${riskLabel} 允许执行 ${chalk.bold(name)}?`,
      `  ${chalk.dim(shortArgs)}`,
      `  ${chalk.dim("[Y] 允许  [n] 拒绝  [a] 本次会话始终允许  [s] 跳过此类工具")}`,
    ].join("\n") + " ";

    const answer = await new Promise<string>((resolve) => {
      rl.question(prompt, resolve);
    });
    const choice = answer.trim().toLowerCase();

    if (choice === "n") return false;           // 拒绝
    if (choice === "a") { autoApprove.set(name, true); console.log(chalk.dim(`  → 已为 ${name} 启用始终允许\n`)); return true; }
    if (choice === "s") {                       // 跳过所有确认
      for (const t of ["write_file", "edit_file", "copy_file", "move_file", "create_directory", "execute_command", "delete_file"]) {
        autoApprove.set(t, true);
      }
      console.log(chalk.dim("  → 已跳过所有工具确认\n"));
      return true;
    }
    return true; // 回车/其他 = 允许
  };

  // 会话管理
  const sessionMgr = new SessionManager();
  sessionMgr.startNew(); // 默认新会话
  let sessionInfo = `新会话 (${sessionMgr.getDir()})`;

  const agent = new Agent(logger, (token: string) => {
    process.stdout.write(token);
  }, context ?? undefined, askConfirm);

  console.log(BANNER(logger.getFilePath(), sessionInfo, contextSummary));

  // 自动保存（每轮后）
  const autoSave = () => sessionMgr.autoSave(agent.getMessages());

  while (true) {
    const input = await ask();
    if (!input) continue;

    // 特殊命令
    if (input.startsWith("/")) {
      const parts = input.split(/\s+/);
      const cmd = parts[0];
      const arg = parts[1];

      switch (cmd) {
        case "/exit":
          autoSave();
          console.log(chalk.dim("👋 再见!"));
          logger.logSessionEnd();
          rl.close();
          return;

        case "/reset":
          autoSave(); // 保存当前
          agent.reset();
          sessionMgr.startNew();
          sessionInfo = `新会话 (${sessionMgr.getCurrentName()})`;
          console.log(chalk.yellow("🔄 新会话已开始\n"));
          continue;

        case "/session": {
          if (arg === "list") {
            const sessions = sessionMgr.list();
            if (sessions.length === 0) {
              console.log(chalk.dim("  暂无历史会话\n"));
            } else {
              console.log(chalk.bold(`\n  历史会话 (${sessionMgr.getDir()}):\n`));
              for (let i = 0; i < sessions.length; i++) {
                const s = sessions[i];
                const current = s.name === sessionMgr.getCurrentName() ? chalk.green(" ← 当前") : "";
                console.log(`  ${chalk.yellow(String(i + 1))}. ${s.label}  ${chalk.dim(`[${s.messageCount}条, ${(s.size / 1024).toFixed(1)}KB]`)}${current}`);
                console.log(`     ${chalk.dim(s.preview)}`);
              }
              console.log();
            }
          } else if (arg === "new") {
            autoSave();
            agent.reset();
            sessionMgr.startNew();
            sessionInfo = `新会话 (${sessionMgr.getCurrentName()})`;
            console.log(chalk.yellow("🔄 新会话已开始\n"));
          } else if (arg === "load" || arg === "delete") {
            const idx = parseInt(parts[2]);
            if (isNaN(idx)) {
              console.log(chalk.red("  用法: /session load <编号> 或 /session delete <编号>\n"));
              continue;
            }
            const sessions = sessionMgr.list();
            if (idx < 1 || idx > sessions.length) {
              console.log(chalk.red(`  无效编号: ${idx} (共 ${sessions.length} 个会话)\n`));
              continue;
            }
            const target = sessions[idx - 1];
            if (arg === "load") {
              autoSave();
              const msgs = sessionMgr.load(target.name);
              if (msgs) {
                agent.setMessages(msgs);
                sessionInfo = `${target.label} (${msgs.length}条)`;
                console.log(chalk.yellow(`📂 已切换到: ${target.label} (${msgs.length} 条消息)\n`));
              }
            } else {
              sessionMgr.delete(target.name);
              console.log(chalk.red(`🗑 已删除: ${target.label}\n`));
            }
          } else {
            console.log(chalk.dim("  用法: /session [list|new|load <N>|delete <N>]\n"));
          }
          continue;
        }

        case "/help":
          console.log(HELP);
          continue;

        default:
          console.log(chalk.red(`未知命令: ${input}，输入 /help 查看可用命令\n`));
          continue;
      }
    }

    // 正常对话（流式输出）
    try {
      process.stdout.write("\n" + chalk.green("🤖 Agent: "));
      await agent.chat(input);
      process.stdout.write("\n\n");
      autoSave();
    } catch (e: any) {
      const errMsg = `❌ 错误: ${e.message}`;
      logger.logError(errMsg);
      console.error(chalk.red(errMsg + "\n"));
    }
  }
}

main();
