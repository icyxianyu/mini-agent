/**
 * 配置模块 — 集中管理所有环境变量和应用设置。
 *
 * 设计原则：
 * - 单一来源：所有配置从 .env 读取，提供合理默认值
 * - 零依赖注入：全局单例，简单直接
 * - 验证入口：提供 validate() 确保必需配置存在
 */
import "dotenv/config";

export const Config = {
  /** LLM API Key（必需）*/
  apiKey: process.env.LLM_API_KEY ?? "",

  /** API Base URL（兼容 OpenAI / DeepSeek / 通义千问 等） */
  baseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",

  /** 模型名称 */
  model: process.env.LLM_MODEL ?? "gpt-4o",

  /** 系统提示词 */
  systemPrompt:
    process.env.SYSTEM_PROMPT ??
    [
      "你是一个 AI 编程助手，拥有读写文件、执行终端命令、搜索代码、委托子Agent的能力。",
      "",
      "## 行为准则",
      "1. 上下文注入中已包含项目结构、配置文件和关键入口文件。先利用已有信息，不要重复获取。",
      "2. ⚠️ 在任何文件中查找特定内容（代码、文本、日志、数据、配置文件等），必须先用 search_content 搜索关键词定位，再根据返回行号用 read_file(offset=行-5, limit=30) 精读命中区域。禁止直接 read_file 全量读取后人工判断。",
      "   ✅ 正确：search_content(\"关键词\") → 根据返回行号 read_file(offset=行-5, limit=30) 精读",
      "   ❌ 错误：read_file(全量读取) → 自己判断内容",
      "   仅当用户说\"读一下这个文件\"或\"显示文件内容\"且未指定要查找什么时，才直接 read_file。",
      "3. 纯文本对话、命令执行（npm test 等）、创建文件时直接行动，不需要搜索。",
      "4. 每个工具的使用方式请参考工具自身的 description，工具描述中已包含最佳实践。",
      "5. workspace 内所有文件操作安全，越界会被拒绝。写/删文件需用户确认。",
      "6. 🔧 子Agent委托：遇到复杂、多步骤的独立任务时，使用 task 工具启动子Agent。子Agent拥有独立上下文，适合代码探索、大规模重构等场景。多个独立子任务可并行调用多个 task。",
      "7. 🧩 Skill 激活：当用户需求匹配某个 Skill 的描述时，务必先用 skill 工具激活获取完整指令再执行，不要凭记忆猜测 Skill 的内容。",
    ].join("\n"),

  /** 工作区根目录，所有文件操作限制在此目录内 */
  workspaceRoot: process.env.WORKSPACE_ROOT || process.cwd(),

  /** 是否启用工具确认（写/删/执行命令前需用户确认） */
  enableToolConfirmation:
    (process.env.ENABLE_TOOL_CONFIRMATION ?? "true") === "true",

  /** 是否启用上下文注入（启动时自动收集项目信息注入 system prompt） */
  enableContextInjection:
    (process.env.ENABLE_CONTEXT_INJECTION ?? "true") === "true",

  /** 目录树最大深度（上下文注入用） */
  contextDirDepth: Number(process.env.CONTEXT_DIR_DEPTH) || 3,

  /** 目录树根层级最大条目数 */
  contextMaxTopEntries: Number(process.env.CONTEXT_MAX_TOP_ENTRIES) || 30,

  /** 模型上下文上限（token 数），必须通过 .env 设置 */
  modelContextLimit: Number(process.env.MODEL_CONTEXT_LIMIT) || 0,

  /** 最大工具调用轮数（防止 LLM 陷入死循环） */
  maxToolRounds: Number(process.env.MAX_TOOL_ROUNDS) || 10,

  /** 工具结果硬截断：最大行数（超出做 middle truncation） */
  toolResultMaxLines: Number(process.env.TOOL_RESULT_MAX_LINES) || 256,

  /** 工具结果硬截断：最大字节数（超出做 middle truncation） */
  toolResultMaxBytes: Number(process.env.TOOL_RESULT_MAX_BYTES) || 10240, // 10 KiB

  /** Skill 目录路径（相对于 workspaceRoot） */
  skillsDir: process.env.SKILLS_DIR || ".mini-agent/skills",

  /** 子 Agent 最大工具调用轮数（默认 8） */
  subAgentMaxRounds: Number(process.env.SUB_AGENT_MAX_ROUNDS) || 8,

  /** 子 Agent 是否默认后台运行（不阻塞主 Agent 流式输出） */
  subAgentBackground: (process.env.SUB_AGENT_BACKGROUND ?? "false") === "true",

  /** Plan 模式是否默认使用并行执行 */
  planParallel: (process.env.PLAN_PARALLEL ?? "true") === "true",

  /** 验证必需配置 */
  validate(): boolean {
    if (!this.apiKey) {
      console.error("❌ LLM_API_KEY 未设置，请检查 .env 文件");
      return false;
    }
    if (!this.modelContextLimit) {
      console.error("❌ MODEL_CONTEXT_LIMIT 未设置，请检查 .env 文件\n  例: MODEL_CONTEXT_LIMIT=128000");
      return false;
    }
    return true;
  },
} as const;
