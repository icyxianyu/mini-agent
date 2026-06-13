/**
 * Skill 系统类型定义 — Agent Skills 开放标准。
 *
 * 一个 Skill 是一个包含 SKILL.md 的目录。
 * SKILL.md = YAML frontmatter（元数据）+ Markdown body（指令）。
 */

/** Skill 元数据（frontmatter 部分） */
export interface SkillMeta {
  /** 技能名称（唯一标识） */
  name: string;
  /** 触发描述，用于 LLM 语义匹配 */
  description: string;
}

/** Skill 完整定义（元数据 + body + 目录路径） */
export interface SkillDefinition extends SkillMeta {
  /** 磁盘目录路径 */
  dir: string;
  /** SKILL.md 的完整 body（指令内容） */
  body: string;
}

/** Frontmatter 解析结果 */
export interface ParsedSkill {
  meta: SkillMeta;
  body: string;
}
