/**
 * 子 Agent 类型定义 — 所有子 Agent 相关的共享接口。
 *
 * 设计要点：
 * - SubAgentType: 内置 Agent 的类型标识
 * - SubAgentConfig: Agent 的完整配置（System Prompt、工具集、模型）
 * - SubAgentResult: 子 Agent 执行完毕后的结构化返回
 * - DelegationPath: 两种委托路径（继承/独立）
 */
import type { BaseTool } from "../tools/base.js";

/** 子 Agent 类型标识 */
export type SubAgentType = "general-purpose" | "explore" | "plan";

/** 委托路径 */
export type DelegationPath = "inherit" | "independent";

/** 子 Agent 配置 */
export interface SubAgentConfig {
  /** 类型标识 */
  type: SubAgentType;
  /** 委托路径 */
  delegation: DelegationPath;
  /** System Prompt（独立路径使用，继承路径忽略） */
  systemPrompt: string;
  /** 允许的工具名称列表（"*" 表示全部，独立路径使用） */
  allowedTools: string[];
  /** 禁止的工具名称列表 */
  disallowedTools: string[];
  /** 工具风险限制（只 read 等） */
  maxRiskLevel?: "read" | "write" | "execute";
  /** 是否后台运行（不阻塞主 Agent 的流式输出） */
  background?: boolean;
  /** 最大工具调用轮数 */
  maxToolRounds?: number;
  /** 描述（用于 TaskTool 的 description 拼接） */
  description: string;
}

/** 子 Agent 执行结果（回传给主 Agent 的结构化数据） */
export interface SubAgentResult {
  /** 执行状态 */
  status: "completed" | "failed" | "timeout";
  /** 子 Agent 的最终文本输出 */
  output: string;
  /** 错误信息（status !== "completed" 时） */
  error?: string;
  /** 工具调用轮数 */
  toolRounds: number;
  /** 修改过的文件路径列表 */
  filesModified: string[];
  /** Token 用量 */
  tokenUsage: {
    prompt: number;
    completion: number;
  };
  /** 如果是 plan 类型，附带生成的计划 */
  plan?: {
    title: string;
    steps: string[];
  };
}

/** 子 Agent 运行回调 */
export interface SubAgentCallbacks {
  /** 工具执行进度（名称 + 参数摘要 → 状态图标） */
  onToolProgress?: (icon: string, message: string) => void;
  /** 流式文本输出 */
  onToken?: (token: string) => void;
}
