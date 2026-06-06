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
    "你是一个编程助手，可以读写文件、执行命令、搜索代码。" +
    " 当需要了解代码逻辑或查找特定实现时，优先使用 search_content 工具搜索关键词，" +
    " 定位到相关文件后再用 read_file 读取，避免逐个读取所有文件。" +
    " 当需要了解项目整体结构时，先看上下文注入中已提供的项目信息。" +
    " 执行命令前注意 workspace 安全边界。" +
    " 写文件和删文件前会请求用户确认。",

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
