/**
 * Skill 管理器 — 注册、查询、匹配、注入。
 *
 * 渐进式披露:
 *   - 启动时: 加载所有 skill 的 metadata（~100 tokens/skill）
 *   - 匹配时: 加载完整 body 注入对话上下文
 */
import type { SkillDefinition, SkillMeta } from "./types.js";
import { loadSkills } from "./loader.js";
import type { Logger } from "../logger.js";

export class SkillManager {
  /** 已加载的所有 skill */
  private skills: SkillDefinition[] = [];
  /** skills 根目录 */
  private readonly rootDir: string;
  /** 日志器 */
  private readonly logger: Logger | null;

  constructor(rootDir: string, logger?: Logger) {
    this.rootDir = rootDir;
    this.logger = logger ?? null;
  }

  // ─── 加载/重载 ──────────────────────────────────

  /** 扫描并加载所有 skill */
  load(): void {
    this.skills = loadSkills(this.rootDir);
    this.logger?.logSystem(
      `[Skill] 加载完成: ${this.skills.length} 个 skill`,
    );
  }

  /** 热重载 */
  reload(): void {
    this.logger?.logSystem("[Skill] 热重载...");
    this.load();
  }

  // ─── 查询 ──────────────────────────────────────

  /** 获取所有 skill */
  getAll(): SkillDefinition[] {
    return this.skills;
  }

  /** 获取所有 metadata（启动时注入 System Prompt 用） */
  getMetadataList(): SkillMeta[] {
    return this.skills.map((s) => ({ name: s.name, description: s.description }));
  }

  /** 按名称查找 */
  findByName(name: string): SkillDefinition | undefined {
    return this.skills.find((s) => s.name === name);
  }

  // ─── 匹配/激活 ────────────────────────────────

  /**
   * 按名称匹配 skill 并返回格式化后的完整指令。
   * 用于 /skill <name> 命令和 LLM 自主调用。
   */
  activate(name: string): SkillDefinition | undefined {
    const skill = this.findByName(name);
    if (!skill) return undefined;
    this.logger?.logSystem(`[Skill] 激活: ${skill.name}`);
    return skill;
  }

  /** 获取可用的 skill 数量 */
  get count(): number {
    return this.skills.length;
  }

  /** 是否为空 */
  get isEmpty(): boolean {
    return this.skills.length === 0;
  }

  // ─── System Prompt 注入 ────────────────────────

  /** 生成 skill 概览文本（注入 System Prompt 用） */
  formatOverview(): string {
    if (this.isEmpty) return "";

    const lines = this.skills.map(
      (s) => `  - **${s.name}**: ${s.description}`,
    );

    return [
      `\n## 可用 Skill`,
      ...lines,
      ``,
      `⚠️ 重要：上述 Skill 是预置的工作流模板。当用户需求明显匹配某个 Skill 的描述时，必须先用 skill 工具激活该 Skill 获取完整指令，不要凭记忆执行。`,
    ].join("\n");
  }
}
