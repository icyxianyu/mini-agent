/**
 * SkillTool — Skill 激活工具。
 *
 * 将 Skill 系统暴露给 LLM 作为 Function Calling 工具，
 * LLM 在看到用户需求匹配 Skill 的 description 时自主调用。
 *
 * ┌────────────────────────────────────────────────────┐
 * │  LLM → system prompt 中有 Skill 列表               │
 * │       → "搭建项目" 匹配 "全栈项目脚手架"            │
 * │       → tool_calls: [{name:"skill", args:{name}}]  │
 * │              │                                     │
 * │              ▼                                     │
 * │         SkillTool.execute()                        │
 * │              │                                     │
 * │         → 返回 Skill 的完整指令文本                  │
 * │         → LLM 基于指令继续执行                       │
 * └────────────────────────────────────────────────────┘
 */
import { ToolBase, ToolResult } from "./base.js";
import type { SkillManager } from "../skill/manager.js";

/** SkillTool 共享状态（由 index.ts 注入 SkillManager 引用） */
export const skillToolState = {
  manager: null as SkillManager | null,
};

export class SkillTool extends ToolBase {
  name = "skill";
  riskLevel = "read" as const;

  description = [
    "激活一个 Skill 获取其完整执行指令。Skill 是预置的可复用工作流模板（如搭建项目、代码审查、测试编写等）。",
    "",
    "## 何时必须使用",
    "- 用户请求匹配某个 Skill 的描述时，必须先调用此工具获取指令",
    "- 不要在没看到完整 Skill 指令的情况下自行猜测步骤",
    "",
    "## 参数",
    "- name: Skill 的精确名称",
  ].join("\n");

  parameters = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Skill 名称，必须与可用列表中的名称完全一致",
      },
    },
    required: ["name"],
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const name = (args.name as string) ?? "";
    if (!name) return ToolResult.fail("name 参数不能为空");

    const mgr = skillToolState.manager;
    if (!mgr) return ToolResult.fail("Skill 系统未初始化");

    const skill = mgr.activate(name);
    if (!skill) {
      const available = mgr.getAll().map((s) => s.name).join("、");
      return ToolResult.fail(
        `未找到 Skill "${name}"。可用 Skill: ${available}`,
      );
    }

    return ToolResult.ok(
      `## Skill: ${skill.name}\n` +
      `Skill 目录: ${skill.dir}\n\n` +
      `${skill.body}`,
    );
  }
}
