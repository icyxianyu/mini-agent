/**
 * 工具注册表 — 统一管理所有可用工具。
 *
 * 每个工具模块只负责定义工具类，注册表负责汇总。
 * 新增工具只需: 1) 创建工具类 2) 在此文件加入 allTools 数组
 */
import type OpenAI from "openai";
import type { BaseTool } from "./base.js";

// 文件操作工具
import {
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  DeleteFileTool,
  CopyFileTool,
  MoveFileTool,
  CreateDirectoryTool,
  ListDirectoryTool,
} from "./file-tools.js";

// Shell 命令工具
import { ShellCommandTool } from "./shell-tools.js";

// 内容搜索工具
import { SearchContentTool } from "./search-tools.js";

// Web 内容获取工具
import { FetchUrlTool } from "./web-tools.js";

// 子 Agent 委托工具
import { TaskTool } from "./task-tool.js";

/** 所有可用工具实例 */
export const allTools: BaseTool[] = [
  // 文件操作
  new ReadFileTool(),
  new WriteFileTool(),
  new EditFileTool(),
  new DeleteFileTool(),
  new CopyFileTool(),
  new MoveFileTool(),
  new CreateDirectoryTool(),
  new ListDirectoryTool(),
  // Shell 命令
  new ShellCommandTool(),
  // 内容搜索
  new SearchContentTool(),
  // Web 内容获取
  new FetchUrlTool(),
  // 子 Agent 委托
  new TaskTool(),
];

/** 根据名称查找工具 */
export function getTool(name: string): BaseTool | undefined {
  return allTools.find((t) => t.name === name);
}

/** 获取所有工具的 OpenAI Schema */
export function getAllToolSchemas(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return allTools.map((t) => t.toOpenAISchema());
}
