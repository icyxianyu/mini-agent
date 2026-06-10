/**
 * Plan 模式 — "先规划，后执行"的任务分解引擎。
 *
 * ┌──────────┐    LLM分析    ┌──────────┐   用户确认    ┌──────────┐
 * │ Research  │ ────────────▶ │  Review  │ ────────────▶ │ Execute  │
 * │ (生成步骤) │               │ (审查迭代) │               │ (逐步执行) │
 * └──────────┘               └──────────┘               └──────────┘
 *                                                             │
 *                                                     ┌───────┴──────┐
 *                                                     ▼              ▼
 *                                                 completed      cancelled
 *
 * 存储目录: .mini-agent/plans/{workspace-hash}/plan-{timestamp}.json
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Config } from "./config.js";
import type { Logger } from "./logger.js";

// ============================================================
// 接口定义
// ============================================================

/** PlanManager 执行步骤所需的最小 Agent 接口（解耦 core.ts） */
export interface PlanAgent {
  chat(userInput: string): Promise<string>;
}

// ============================================================
// 类型定义
// ============================================================

export type PlanStatus = "research" | "review" | "executing" | "completed" | "cancelled";
export type StepStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export interface PlanStep {
  id: number;
  description: string;
  status: StepStatus;
  /** 完成后的结果摘要（LLM 输出） */
  result?: string;
  /** 失败时的错误信息 */
  error?: string;
  /** 重试次数 */
  retries: number;
  /** 依赖的步骤 ID 列表（这些步骤完成后才能开始当前步骤） */
  dependsOn: number[];
}

export interface Plan {
  id: string;
  title: string;
  status: PlanStatus;
  steps: PlanStep[];
  currentStep: number; // 当前执行到第几步（index in steps, -1 表示未开始）
  createdAt: string;
  completedAt?: string;
  /** 原始用户请求 */
  request: string;
}

// ============================================================
// 状态流转校验
// ============================================================

const validPlanTransitions: Record<PlanStatus, PlanStatus[]> = {
  research: ["review", "cancelled"],
  review: ["executing", "cancelled"],
  executing: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

const validStepTransitions: Record<StepStatus, StepStatus[]> = {
  pending: ["in_progress", "skipped"],
  in_progress: ["completed", "failed"],
  completed: [],
  failed: ["in_progress", "skipped"], // 重试或跳过
  skipped: [],
};

function validateTransition<T extends string>(
  from: T,
  to: T,
  valid: Record<T, T[]>,
  context: string,
): void {
  if (!valid[from].includes(to)) {
    throw new Error(`${context}: 不允许从 ${from} 切换到 ${to}`);
  }
}

// ============================================================
// PlanManager
// ============================================================

export class PlanManager {
  private plan: Plan | null = null;
  private readonly plansDir: string;

  constructor() {
    const wsHash = crypto.createHash("md5").update(Config.workspaceRoot).digest("hex").slice(0, 8);
    this.plansDir = path.join(Config.workspaceRoot, ".mini-agent", "plans", wsHash);
  }

  // ---- 状态查询 ----

  get current(): Plan | null {
    return this.plan;
  }

  get isActive(): boolean {
    return this.plan !== null && ["research", "review", "executing"].includes(this.plan.status);
  }

  get isExecuting(): boolean {
    return this.plan?.status === "executing";
  }

  get currentStep(): PlanStep | null {
    if (!this.plan || this.plan.currentStep < 0) return null;
    return this.plan.steps[this.plan.currentStep] ?? null;
  }

  // ---- 生命周期 ----

  /** 创建一个新 Plan（进入 research 阶段） */
  create(request: string): Plan {
    if (this.isActive) {
      throw new Error("已有活跃的 Plan，请先 /plan cancel");
    }
    const now = new Date().toISOString();
    this.plan = {
      id: `plan-${now.replace(/[:.]/g, "-")}`,
      title: "",
      status: "research",
      steps: [],
      currentStep: -1,
      createdAt: now,
      request,
    };
    this.save();
    return this.plan;
  }

  /** 设置 LLM 生成的标题和步骤（research → review） */
  setPlan(title: string, steps: Array<{ id: number; description: string; dependsOn?: number[] }>): void {
    if (!this.plan) throw new Error("没有活跃的 Plan");
    validateTransition(this.plan.status, "review", validPlanTransitions, "Plan");

    this.plan.title = title;
    this.plan.status = "review";
    this.plan.steps = steps.map((s) => ({
      ...s,
      dependsOn: s.dependsOn ?? [],
      status: "pending" as StepStatus,
      retries: 0,
    }));
    this.save();
  }

  /** 用户批准，进入执行阶段（review → executing） */
  approve(): void {
    if (!this.plan) throw new Error("没有活跃的 Plan");
    validateTransition(this.plan.status, "executing", validPlanTransitions, "Plan");

    this.plan.status = "executing";
    // 从第一个 pending 的步骤开始
    if (this.plan.steps.length > 0) {
      this.plan.currentStep = 0;
      this.plan.steps[0].status = "in_progress";
    }
    this.save();
  }

  /** 取消当前 Plan */
  cancel(): void {
    if (!this.plan) return;
    if (this.plan.status !== "cancelled" && this.plan.status !== "completed") {
      this.plan.status = "cancelled";
      this.save();
    }
  }

  /** Agent 自主探索项目并生成步骤列表（research → review） */
  async generateSteps(agent: PlanAgent, logger: Logger): Promise<void> {
    if (!this.plan) throw new Error("没有活跃的 Plan");
    if (this.plan.status !== "research") throw new Error("Plan 不在 research 阶段");

    const prompt = `分析这个项目，为以下需求制定一个具体可执行的步骤列表。

## 用户需求
${this.plan.request}

## 你的任务
1. 先用只读工具（list_dir、read_file、search_content）探索项目结构和关键代码
2. 充分了解项目后再制定步骤
3. 输出一段 JSON（不要任何 Markdown 标记或其他文字）：

{
  "title": "计划标题（15字以内）",
  "steps": [
    {
      "description": "步骤1：具体操作，指明文件或模块路径",
      "dependsOn": []
    },
    {
      "description": "步骤2：依赖步骤1完成后才能执行的操作",
      "dependsOn": [1]
    }
  ]
}

## 规则
- 步骤 3~8 个
- 每个步骤是一条具体的操作指令（如"创建 src/Cache.ts，实现 LRU 缓存类"）
- dependsOn 指定依赖的步骤 ID 列表，无依赖则为空数组 []
- 可以并行执行的步骤不要设置依赖关系
- 涉及已有代码时指明具体文件路径`;

    logger.logSystem("Agent 正在探索项目并生成 Plan 步骤...");
    const reply = await agent.chat(prompt);

    const { title, steps } = this.parsePlanResponse(reply);

    if (steps.length === 0) {
      throw new Error("LLM 未生成有效步骤，请重试");
    }

    this.setPlan(title, steps);
    logger.logSystem(`Plan 已生成: "${title}" ${steps.length} 个步骤`);
  }

  /** 解析 LLM 返回的 JSON 计划 */
  private parsePlanResponse(text: string): { title: string; steps: { id: number; description: string; dependsOn?: number[] }[] } {
    // 去除 markdown 代码块包裹
    let jsonStr = text.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    // 尝试直接解析
    let parsed: { title?: string; steps?: (string | { description: string; dependsOn?: number[] })[] } = {};
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // 宽松匹配：提取第一个 { ... } 块
      const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (braceMatch) {
        try { parsed = JSON.parse(braceMatch[0]); } catch { /* 放弃 */ }
      }
    }

    const title = parsed.title ?? "计划";
    const rawSteps = parsed.steps ?? [];

    // 兼容两种格式：字符串数组 或 对象数组（含 dependsOn）
    const steps: { id: number; description: string; dependsOn?: number[] }[] = [];
    for (let i = 0; i < rawSteps.length; i++) {
      const s = rawSteps[i];
      if (typeof s === "string") {
        if (s.trim()) steps.push({ id: i + 1, description: s.trim() });
      } else if (s && typeof s === "object" && s.description) {
        const item: { id: number; description: string; dependsOn?: number[] } = {
          id: i + 1,
          description: s.description.trim(),
        };
        if (Array.isArray(s.dependsOn)) {
          item.dependsOn = s.dependsOn;
        }
        steps.push(item);
      }
    }

    return { title, steps };
  }

  // ---- 步骤操作 ----

  /** 标记当前步骤完成，推进到下一步 */
  completeStep(result: string): PlanStep | null {
    if (!this.plan || !this.isExecuting) throw new Error("Plan 未在执行中");

    const step = this.plan.steps[this.plan.currentStep];
    if (!step) throw new Error("当前步骤不存在");

    validateTransition(step.status, "completed", validStepTransitions, `步骤 ${step.id}`);
    step.status = "completed";
    step.result = result;

    // 推进到下一个 pending 步骤
    this.advanceToNextPending();

    if (this.plan.currentStep === -1) {
      // 没有更多步骤了
      this.plan.status = "completed";
      this.plan.completedAt = new Date().toISOString();
    }
    this.save();
    return this.currentStep;
  }

  /** 标记当前步骤失败 */
  failStep(error: string): PlanStep {
    if (!this.plan || !this.isExecuting) throw new Error("Plan 未在执行中");

    const step = this.plan.steps[this.plan.currentStep];
    if (!step) throw new Error("当前步骤不存在");

    validateTransition(step.status, "failed", validStepTransitions, `步骤 ${step.id}`);
    step.status = "failed";
    step.error = error;
    step.retries++;
    this.save();
    return step;
  }

  /** 重试失败的步骤 */
  retryStep(stepId: number): PlanStep | null {
    if (!this.plan || !this.isExecuting) throw new Error("Plan 未在执行中");

    const step = this.plan.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`步骤 ${stepId} 不存在`);
    if (step.status !== "failed") throw new Error(`步骤 ${stepId} 未失败，无法重试`);

    validateTransition(step.status, "in_progress", validStepTransitions, `重试步骤 ${step.id}`);
    step.status = "in_progress";
    step.error = undefined;
    this.plan.currentStep = this.plan.steps.indexOf(step);
    this.save();
    return step;
  }

  /** 跳过失败的步骤 */
  skipStep(stepId: number): void {
    if (!this.plan || !this.isExecuting) throw new Error("Plan 未在执行中");

    const step = this.plan.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`步骤 ${stepId} 不存在`);

    validateTransition(step.status, "skipped", validStepTransitions, `跳过步骤 ${step.id}`);
    step.status = "skipped";

    // 如果当前正在执行该步骤，推进到下一个
    if (this.plan.currentStep === this.plan.steps.indexOf(step)) {
      this.advanceToNextPending();
    }
    this.save();
  }

  // ---- 文件 I/O ----

  private save(): void {
    if (!this.plan) return;
    fs.mkdirSync(this.plansDir, { recursive: true });
    const filePath = path.join(this.plansDir, `${this.plan.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(this.plan, null, 2), "utf-8");
  }

  /** 从文件加载 Plan */
  load(planId: string): Plan | null {
    const filePath = path.join(this.plansDir, `${planId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = fs.readFileSync(filePath, "utf-8");
      this.plan = JSON.parse(data) as Plan;
      return this.plan;
    } catch {
      return null;
    }
  }

  /** 列出所有历史 Plan */
  list(): Plan[] {
    if (!fs.existsSync(this.plansDir)) return [];
    const files = fs.readdirSync(this.plansDir).filter((f) => f.endsWith(".json"));
    const plans: Plan[] = [];
    for (const f of files) {
      try {
        const data = fs.readFileSync(path.join(this.plansDir, f), "utf-8");
        plans.push(JSON.parse(data) as Plan);
      } catch { /* 跳过损坏文件 */ }
    }
    return plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 销毁当前 Plan（从内存清除，保留文件） */
  clear(): void {
    this.plan = null;
  }

  // ---- 终端渲染 ----

  /** 渲染进度条 */
  render(): string {
    if (!this.plan) return "（无活跃 Plan）";

    const statusIcon: Record<PlanStatus, string> = {
      research: "🔍",
      review: "📋",
      executing: "⚡",
      completed: "✅",
      cancelled: "❌",
    };

    const stepIcon: Record<StepStatus, string> = {
      pending: "⬜",
      in_progress: "⏳",
      completed: "✅",
      failed: "❌",
      skipped: "⏭️",
    };

    const lines: string[] = [];
    lines.push(`\n${statusIcon[this.plan.status]} ${this.plan.title || "（未命名计划）"} [${this.plan.status}]`);

    if (this.plan.steps.length > 0) {
      for (const s of this.plan.steps) {
        const mark = stepIcon[s.status];
        let line = `  ${mark} ${s.id}. ${s.description}`;
        if (s.status === "failed" && s.error) {
          line += ` — ${s.error.slice(0, 60)}`;
        }
        lines.push(line);
      }
    } else {
      lines.push("  （等待 LLM 生成步骤...）");
    }

    // 进度统计
    const total = this.plan.steps.length;
    if (total > 0) {
      const done = this.plan.steps.filter((s) => s.status === "completed").length;
      const failed = this.plan.steps.filter((s) => s.status === "failed").length;
      const skipped = this.plan.steps.filter((s) => s.status === "skipped").length;
      lines.push(`\n  进度: ${done + skipped}/${total} 完成` + (failed > 0 ? `, ${failed} 失败` : ""));
    }

    return lines.join("\n");
  }

  /** 获取下一步指引文本（注入到 Agent 对话中） */
  getStepPrompt(): string | null {
    if (!this.plan || !this.isExecuting) return null;
    const step = this.currentStep;
    if (!step) return null;
    return `请执行计划步骤 ${step.id}/${this.plan.steps.length}:\n\n${step.description}\n\n完成后请简要说明执行结果。`;
  }

  // ---- 内部方法 ----

  /** 推进到下一个 pending 步骤 */
  private advanceToNextPending(): void {
    if (!this.plan) return;
    const plan = this.plan;
    const next = plan.steps.findIndex(
      (s, i) => i > plan.currentStep && s.status === "pending",
    );
    if (next !== -1) {
      this.plan.currentStep = next;
      this.plan.steps[next].status = "in_progress";
    } else {
      this.plan.currentStep = -1; // 没有更多步骤了
    }
  }

  // ---- 执行循环 ----

  /** 逐步执行所有 Plan 步骤。返回 true=全部完成，false=中途取消/失败 */
  async executeSteps(agent: PlanAgent, onProgress: (plan: Plan) => void): Promise<boolean> {
    const maxRetries = 3; // 每个步骤最多自动重试 2 次（允许 1 次初始 + 2 次重试）

    while (this.isExecuting) {
      const stepPrompt = this.getStepPrompt();
      if (!stepPrompt) break;

      try {
        const reply = await agent.chat(stepPrompt);
        this.completeStep(reply);
      } catch (e: any) {
        const errorMsg = e.message ?? String(e);
        this.failStep(errorMsg);

        const currentStep = this.plan?.steps[this.plan?.currentStep ?? -1];
        if (currentStep && currentStep.retries < maxRetries) {
          // 自动重试
          this.retryStep(currentStep.id);
        } else if (currentStep) {
          // 超过重试上限 → 跳过该步骤
          this.skipStep(currentStep.id);
        } else {
          // 极端兜底：找不到当前步骤 → 标记 Plan 为 completed 退出循环
          this.plan!.status = "completed";
        }
      }

      onProgress(this.plan!);

      if (this.plan?.status === "completed") {
        return true;
      }
      if (this.plan?.status === "cancelled") {
        return false;
      }
    }

    return this.plan?.status === "completed";
  }

  /**
   * 并行执行所有 Plan 步骤（根据 dependsOn 依赖关系分批并发）。
   * 
   * 与 executeSteps（严格顺序）不同，此方法将无依赖的步骤放入同一批次并行执行。
   * 每批次内步骤并发运行，批次之间按依赖串行等待。
   * 
   * @param parallelAgent - 支持并行调用的 Agent 接口
   * @param onProgress - 每批次完成后的进度回调
   * @returns true=全部完成, false=中途取消/失败
   */
  async executeStepsParallel(
    parallelAgent: PlanAgent,
    onProgress: (plan: Plan) => void,
  ): Promise<boolean> {
    if (!this.plan || !this.isExecuting) return false;

    const maxRetries = 3;

    // 分批：将所有步骤按依赖关系分组
    const batches = this.buildDependencyBatches();
    for (const batch of batches) {
      // 设置批次内所有步骤为 in_progress
      for (const step of batch) {
        step.status = "in_progress";
      }
      onProgress(this.plan);
      this.save();

      // 并行执行批次内所有步骤
      const results = await Promise.allSettled(
        batch.map((step) =>
          this.executeSingleStep(parallelAgent, step, maxRetries),
        ),
      );

      // 处理结果
      for (let i = 0; i < batch.length; i++) {
        const step = batch[i];
        const settled = results[i];
        if (settled.status === "fulfilled") {
          if (settled.value.success) {
            step.result = settled.value.output;
            step.status = "completed";
          } else {
            step.error = settled.value.error;
            step.status = "failed";
            step.retries = maxRetries; // 重试已耗尽
            // 自动跳过失败的步骤（避免阻塞后续批次）
            this.skipStep(step.id);
          }
        } else {
          step.error = settled.reason?.message ?? "未知并行错误";
          step.status = "failed";
          step.retries = maxRetries;
          this.skipStep(step.id);
        }
      }

      this.save();
      onProgress(this.plan);

      if (this.plan?.status === "cancelled") return false;
    }

    // 所有批次完成
    this.plan!.status = "completed";
    this.plan!.completedAt = new Date().toISOString();
    this.plan!.currentStep = -1;
    this.save();
    return true;
  }

  /** 构建依赖批次：将无依赖关系的步骤放入同一批次 */
  private buildDependencyBatches(): PlanStep[][] {
    if (!this.plan) return [];

    const steps = this.plan.steps;
    const completed = new Set<number>();
    const batches: PlanStep[][] = [];

    while (completed.size < steps.length) {
      const batch: PlanStep[] = [];

      for (const step of steps) {
        if (completed.has(step.id)) continue;
        // 所有依赖已完成则可加入当前批次
        const depsDone = step.dependsOn.every((depId) => completed.has(depId));
        if (depsDone) {
          batch.push(step);
        }
      }

      if (batch.length === 0) {
        // 循环依赖或逻辑错误：把剩余全部加入最后批次
        for (const step of steps) {
          if (!completed.has(step.id)) batch.push(step);
        }
      }

      for (const s of batch) completed.add(s.id);
      batches.push(batch);
    }

    return batches;
  }

  /** 执行单个步骤（含重试逻辑），返回 {success, output, error} */
  private async executeSingleStep(
    agent: PlanAgent,
    step: PlanStep,
    maxRetries: number,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    let lastError: string | undefined;
    const stepPrompt = `请执行计划步骤 ${step.id}/${this.plan?.steps.length ?? "?"}:\n\n${step.description}\n\n完成后请简要说明执行结果。`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const reply = await agent.chat(stepPrompt);
        return { success: true, output: reply };
      } catch (e: any) {
        lastError = e.message ?? String(e);
        if (attempt >= maxRetries) break;
      }
    }

    return { success: false, error: lastError };
  }
}
