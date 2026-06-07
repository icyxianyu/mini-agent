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
      "你是一个 AI 编程助手，拥有读写文件、执行终端命令、搜索代码的能力。",
      "",
      "## 行为准则",
      "1. 上下文注入中已包含项目结构、配置文件和关键入口文件。先利用已有信息，不要重复获取。",
      "2. ⚠️ 探索/理解代码逻辑时必须先 search_content 定位，禁止在搜索前直接 read_file 或 list_directory 后逐个读取。",
      "   ✅ 正确：search_content(\"关键词\") → 根据返回行号 read_file(offset=行-5, limit=30) 精读",
      "   ❌ 错误：list_directory → read_file(逐个文件全量读取)",
      "   仅当需要回答\"项目有哪些文件\"等纯粹的结构性问题时，才使用 list_directory。",
      "3. 纯文本对话、命令执行（npm test 等）、创建文件时直接行动，不需要搜索。",
      "4. 每个工具的使用方式请参考工具自身的 description，工具描述中已包含最佳实践。",
      "5. workspace 内所有文件操作安全，越界会被拒绝。写/删文件需用户确认。",
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

  /** 最大工具调用轮数（防止 LLM 陷入死循环） */
  maxToolRounds: Number(process.env.MAX_TOOL_ROUNDS) || 10,

  /** 验证必需配置 */
  validate(): boolean {
    if (!this.apiKey) {
      console.error("❌ LLM_API_KEY 未设置，请检查 .env 文件");
      return false;
    }
    return true;
  },
} as const;
