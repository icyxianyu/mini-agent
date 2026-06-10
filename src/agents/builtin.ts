/**
 * 内置子 Agent 定义 — 三种类型，覆盖不同任务场景。
 *
 * ┌─────────────────────┬──────────┬──────────────────────┐
 * │ Agent               │ 委托路径 │ 工具                  │
 * ├─────────────────────┼──────────┼──────────────────────┤
 * │ general-purpose     │ inherit  │ 全部（继承父 Agent）  │
 * │ explore             │ inherit  │ 只读（继承 + 过滤）   │
 * │ plan                │ independ.│ 只读 + 独立 Prompt    │
 * └─────────────────────┴──────────┴──────────────────────┘
 */
import type { SubAgentConfig } from "./types.js";

/** 通用 Agent — 继承父 Agent 的 System Prompt + 全部工具 */
export const GeneralPurposeAgent: SubAgentConfig = {
  type: "general-purpose",
  delegation: "inherit",
  systemPrompt: "", // 继承路径不使用自己的 System Prompt
  allowedTools: ["*"],
  disallowedTools: ["task"], // 禁止嵌套委托（防止无限递归）
  description: "通用子Agent，拥有完整工具能力。适合代码重构、多文件操作、功能开发等需要全能力集的复杂任务。",
};

/** 探索 Agent — 继承父 Agent 的上下文但只给只读工具 */
export const ExploreAgent: SubAgentConfig = {
  type: "explore",
  delegation: "inherit",
  systemPrompt: "",
  allowedTools: ["*"],
  disallowedTools: [
    "write_file",
    "edit_file",
    "delete_file",
    "copy_file",
    "move_file",
    "create_directory",
    "execute_command",
    "task",
  ],
  maxRiskLevel: "read",
  background: true,
  description: "代码探索Agent，只有只读权限。适合项目结构分析、代码搜索、依赖关系梳理等纯分析任务。",
};

/** 规划 Agent — 独立 System Prompt，只给只读工具，专注于任务分解 */
export const PlanAgent: SubAgentConfig = {
  type: "plan",
  delegation: "independent",
  systemPrompt: [
    "你是一个项目规划专家。你的职责是分析用户需求，充分探索项目代码后，制定具体可执行的实施步骤。",
    "",
    "## 工作流程",
    "1. 先用 read_file、list_directory、search_content 探索项目结构和关键代码",
    "2. 理解项目架构后，将需求分解为 3~8 个具体的执行步骤",
    "3. 输出严格 JSON（不要 Markdown 标记或其他文字）：",
    "",
    "```json",
    "{",
    '  "title": "计划标题（15字以内）",',
    '  "steps": [',
    '    "步骤1：具体操作描述，指明文件或模块路径",',
    '    "步骤2：...",',
    '    "..."',
    "  ]",
    "}",
    "```",
    "",
    "## 规则",
    "- 步骤按依赖顺序排列",
    "- 每个步骤是具体的操作指令，不是抽象目标",
    "- 涉及已有代码时指明具体文件路径",
    "- 只输出 JSON，不要任何解释性文字",
  ].join("\n"),
  allowedTools: ["*"],
  disallowedTools: [
    "write_file",
    "edit_file",
    "delete_file",
    "copy_file",
    "move_file",
    "create_directory",
    "execute_command",
    "task",
  ],
  maxRiskLevel: "read",
  maxToolRounds: 6, // 探索 + 规划，一般 3~5 轮足矣
  description: "项目规划Agent，只有只读权限。适合需要分析项目结构后制定实施计划的场景。输出结构化 JSON 步骤列表。",
};

/** 所有内置 Agent 配置表 */
export const BUILTIN_AGENTS: Record<string, SubAgentConfig> = {
  "general-purpose": GeneralPurposeAgent,
  general: GeneralPurposeAgent,
  explore: ExploreAgent,
  plan: PlanAgent,
};
