/**
 * Skill 加载器 — 扫描目录、解析 SKILL.md。
 *
 * 发现路径:
 *   .mini-agent/skills/<skill-name>/skill.md
 *
 * 格式:
 *   ---
 *   name: 技能名称
 *   description: 触发描述
 *   ---
 *   技能指令正文...
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SkillDefinition, SkillMeta, ParsedSkill } from "./types.js";

/**
 * 解析 SKILL.md 的 YAML frontmatter。
 * 不依赖 yaml 库，手写简单解析器支持 string 值。
 */
export function parseFrontmatter(content: string): ParsedSkill {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    // 没有 frontmatter，整篇当作 body，name 取目录名
    return {
      meta: { name: "", description: "" },
      body: content.trim(),
    };
  }

  const endIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (endIdx === -1) {
    return { meta: { name: "", description: "" }, body: content.trim() };
  }

  const frontmatterLines = lines.slice(1, endIdx);
  const body = lines.slice(endIdx + 1).join("\n").trim();

  const meta: Record<string, string> = {};
  for (const line of frontmatterLines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // 去掉首尾引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }

  return {
    meta: {
      name: meta.name ?? "",
      description: meta.description ?? "",
    },
    body,
  };
}

/**
 * 扫描 skills 目录，加载所有 skill。
 * 目录结构: <skillsRoot>/<skill-name>/skill.md
 */
export function loadSkills(skillsRoot: string): SkillDefinition[] {
  if (!existsSync(skillsRoot)) return [];

  const skills: SkillDefinition[] = [];

  try {
    const entries = readdirSync(skillsRoot);
    for (const entry of entries) {
      const dir = join(skillsRoot, entry);
      if (!statSync(dir).isDirectory()) continue;

      // 兼容 skill.md 和 SKILL.md
      const lowerPath = join(dir, "skill.md");
      const upperPath = join(dir, "SKILL.md");
      const skillMdPath = existsSync(lowerPath) ? lowerPath : existsSync(upperPath) ? upperPath : null;
      if (!skillMdPath) continue;

      const content = readFileSync(skillMdPath, "utf-8");
      const parsed = parseFrontmatter(content);

      // name 缺失时用目录名
      const name = parsed.meta.name || entry;
      const description = parsed.meta.description || `${name} 技能`;

      skills.push({
        name,
        description,
        dir,
        body: parsed.body,
      });
    }
  } catch {
    // 目录不可读则跳过
  }

  return skills;
}
