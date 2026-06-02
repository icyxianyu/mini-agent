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
    "你是一个编程助手，可以读写文件、帮助用户完成编程任务。",

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
