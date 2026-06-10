# 问题记录与修复

## 1. LLM 全量读取文件而非搜索定位

**发现时间：** 2026-06-06

**现象：** 用户问"项目的错误恢复逻辑"，LLM 调了 13 次工具——先用 `list_directory` 列出所有文件，然后逐个 `read_file` 读完全部源文件。

**根因：** LLM 不理解 token 成本，默认采用"全量阅读"以确保信息完整，而不是"搜索优先"节约调用次数。

**修复方式：** 在 `src/config.ts` 的默认 system prompt 中加入搜索优先策略指引：

```
"当需要了解代码逻辑或查找特定实现时，优先使用 search_content 工具搜索关键词，
 定位到相关文件后再用 read_file 读取，避免逐个读取所有文件。"
```

**效果（v1）：**
- 同样的问题，工具调用从 13 次降到 5 次
- 无关文件读取从 11 个降到 1 个
- LLM 第一次调用就用了 search_content 定位

**问题（v1 不够强）：** 问"危险层级"时 LLM 又回到 list_directory + 全量读取，因为"危险层级"被理解为设计理念而非代码逻辑，没触发 search 路径。

**修复 v2：** 改为强制性指令——"回答代码问题时必须先 search_content，禁止在搜索前 read_file 或 list_directory + 逐个读取。上下文注入中已含项目结构，无需额外 list_directory。"

**效果（v2）：** 强制 search-first，不再依赖 LLM 自行判断"该不该搜"。

**问题（v2 过于强制）：** "必须先 search" 对纯粹的命令执行、创建文件等场景不适合。

**修复 v3：** 改为引导式——"探索代码时优先 search_content 定位"，并明确"纯粹查询/命令/创建直接行动"，由 LLM 自行判断场景。

**问题（v3 只搜不精读）：** search 后 LLM 仍然完整读取搜索命中的文件，虽然 search 到的行号已给出，但没用 read_file 的 offset/limit 参数。

**修复 v4：** 明确指引——"用 read_file 的 offset/limit 只读命中行附近的内容，不必读完整文件"。效果：LLM 读的内容变少了，但仍会完整读搜索命中的文件。

**修复 v5（Claude Code 风格）：** 用大量 system prompt token 换取工具调用节省。system prompt 扩充到 ~500 tokens，为每个工具写独立的使用规范段（search_content、read_file、execute_command、write/edit/delete）。

**问题（v5 维护成本高）：** 新增工具需同时更新 system prompt 和工具 description，两处维护容易不同步。

**修复 v6（工具自描述）：** system prompt 精简回 ~150 tokens（仅行为准则）。工具使用规范下沉到各工具自身的 `description` 字段——LLM 在 function schema 中直接看到。新增工具只需写好自己的 description，不再需要动 system prompt。

**最终效果：**
| 迭代 | system prompt | 工具调用 | 维护成本 | 新增工具 |
|------|:----------:|:------:|:------:|:------:|
| 原始 | 50 tokens | 13 次 | 低 | 只改 description |
| v1-v4 | 50~100 tokens | 5~9 次 | 低 | 只改 description |
| v5 | 500 tokens | ~4 次 | 高 | 改两处 |
| v6 | 150 tokens | ~4 次 | 低 | 只改 description |

**v6 实测：**
- flash（deepseek-v4-flash）：仍全量读 7 文件，仅 index.ts 用 offset/limit
- pro（gpt-4o-pro）：search 先搜 ✅，但精读仍是全文件，offset/limit 未生效
- 35k 对于跨文件分布式机制的问题是合理范围，剩余优化空间约 23k
- list_directory 是唯一多余调用（上下文已有结构）
- 结论：offset/limit 对主流模型都不太好跟，后续考虑在 read_file 默认行为上做"自动分段"来根本解决

---

## 2. read_file 默认限制 200 行——工具行为反推 LLM 习惯

**发现时间：** 2026-06-07

**背景：** 问题 1 的 v6 迭代发现，LLM 不主动用 offset/limit，怎么 prompt 都改不过来。

**方案：** 不改 LLM，改工具——`read_file` 无参数时默认只返回前 200 行，末尾提示剩余行数和翻页用法。

**效果：**
| 指标 | 之前 | 之后 |
|------|:--:|:--:|
| 单轮 token | 35.1k | 25.2k |
| 降幅 | — | -28% |
| LLM 行为 | 全量读 6 文件 | 大文件自动 offset/limit，小文件全量 |

LLM 看到"返回了 200 行 + 剩余提示"后，自然学会了精确传 offset/limit 翻页——不是被 prompt 说服的，是被工具限制逼出来的。

**教训：** 优化 LLM 行为有两个方向。prompt 引导是软的、边际递减的；工具限制是硬的、一次生效的。优先用后者。

---

## 3. 搜索优先强化——双管齐下

**发现时间：** 2026-06-07

**背景：** 用户问"search_content 返回给模型的数据是什么"，LLM 仍直接 `read_file(search-tools.ts)` 而不先用 `search_content` 定位。即使已有多轮 system prompt 迭代 + 工具 description 引导，搜索优先仍不稳定。

**方案：** 方向 1 + 方向 2 组合

**方向 1（prompt 强化）：** system prompt 规则 2 从语气升级为正反例：
- 旧：`回答代码问题时遵循：search_content 定位 → read_file 精读。先搜后读。`
- 新：`⚠️ 探索/理解代码逻辑时必须先 search_content 定位，禁止在搜索前直接 read_file。✅ 正确 / ❌ 错误 正反例`

**方向 2（工具返回暗示）：** `read_file` 无 offset 读取源码文件时，返回内容末尾追加：
```
💡 搜索优先：如需定位特定代码，使用 search_content 搜索关键词，再用 offset/limit 精读命中区域。
```
- 仅对源码文件（.ts/.js/.py 等）追加该提示
- 对 .md/.json/.yml 等非源码文件不追加
- 对指定了 offset 的精读不追加（说明 LLM 已在搜索后精读）

**原理：** LLM 对工具返回内容高度敏感。该提示直接进入消息历史，下一轮推理时能看到，比 system prompt 距离推理点更近。

---

## 4. Token 计数不准确 + 上下文窗口 vs 累计用量混淆

**发现时间：** 2026-06-07

**现象：** 终端显示 "⚡ 本轮 +304.7k tokens"，但 compressHistory 从未触发，怀疑压缩有 bug。

**根因 1 — 标签误导：** "本轮" 实际显示的是 `totalUsage`（会话累计所有 API 调用的输入+输出总和），不是单次 API 调用的 messages 大小。真正应该关心的是每次调用时 `compressHistory` 检查的 messages token 数。

**根因 2 — 计数不准：** `estimateTokens` 用的是 `JSON.stringify(messages).length / 4`，实测比真实 token 数低 16~26%（中文场景偏差更大）。导致 messages 实际已经接近上限，估算值还远未到 80% 阈值。

**修复方式：**

1. **精确计数**：用 `gpt-tokenizer` 的 `encodeChat` 替代字符数/4。`encodeChat` 会计算 OpenAI 协议层注入的特殊 token（每条消息的 role 标记等）。
   - 实测：中文对话场景偏差从 -26% 降到 0%

2. **显示改进**：终端输出改为 `📊 上下文 88.5k/128k (69%) | ⚡ 累计 输入134.1k 输出4.5k`
   - 左侧：当前 messages 实际占用 / 窗口上限 + 百分比
   - 右侧：会话累计开销
   - ≥80% 变黄提醒

**教训：** "本轮" 这种模糊标签是万恶之源。累计和上下文窗口是两个完全不同的概念，展示时必须明确区分。

---

## 5. compressHistory 的 5 个结构性缺陷

**发现时间：** 2026-06-07

发现压缩函数存在以下问题：

| # | 问题 | 修复 |
|---|------|------|
| 1 | 压缩时机：用户新消息先 push 再压缩，挤占保留配额 | 先 `compressHistory()` 再 `push` |
| 2 | 摘要丢失工具链路：oldText 只取 user+assistant 文本，tool_call/tool_result 被跳过 | oldText 新增 `工具调用: read_file → edit_file` 行 |
| 3 | 摘要嵌套退化：压缩后的摘要轮次被再次总结，信息指数级衰减 | 检测 `[对话历史摘要]` 前缀，原文照搬 |
| 4 | 不验证压缩效果：只打日志不检查是否真降到阈值以下 | while 循环逐步减少 keepCount，最后硬截断兜底 |
| 5 | 无错误处理：摘要 API 失败整个对话崩 | `trySummarize()` 返回 `{success}`，失败回退简单截断 |

修复后压缩链路：
```
超标 → 提取工具链路 + 防嵌套 → LLM 摘要
  ├─ 成功 → 验证 → 仍超标则减 keepCount → 仍超标硬截断
  └─ 失败 → 回退简单截断
```

---

## 6. 并行工具执行导致 readline 确认冲突

**发现时间：** 2026-06-07

**现象：** 当多个 `execute_command` 同时出现在一批 tool_calls 中时，`Promise.all` 并行执行使多个 `rl.question` 同时活跃，导致：
- 输入框被上次输出的 `⏳ execute_command {args}` 污染
- 确认行为不可预测
- 对话可能中途卡死

**根因：** `executeTool` 中对 `riskLevel !== "read"` 的工具调用 `askConfirm`，而 `askConfirm` 内部用 `rl.question`。Node.js readline 不支持同时多个 `question`。

**修复方式：** 检测批次中是否有需确认的工具，有则串行执行（`executeToolsSerially`），无则保持并行。
```
批次中 any tool.riskLevel !== "read"？
  ├─ 是 → 串行（一个接一个确认）
  └─ 否 → 并行（Promise.all，读操作不受影响）
```

---

## 7. encodeChat 遇到特殊 token 报错

**发现时间：** 2026-06-07

**现象：** `❌ 错误: Disallowed special token found: <|im_start|>`

**根因：** LLM 回复中提到了 OpenAI chat format 协议（如 `<|im_start|>` 和 `<|im_end|>`），这些文本被写入 messages。`gpt-tokenizer` 的 `encodeChat` 检测到内容中有协议保留 token，误以为在注入控制指令，直接抛错。

**修复方式：** 在 `estimateTokens` 中 `sanitize` 替换：`<|im_start|>` → `[im_start]`、`<|im_end|>` → `[im_end]`。替换后 token 数不变（都是 1 个特殊 token）。

---

## 9. 子 Agent 委托系统设计 — Tool-as-Agent 模式

**发现时间：** 2026-06-10

**背景：** 需要实现子 Agent 委托，让 LLM 能自主决定何时 spawn 子 Agent 处理复杂任务。

**设计方案调研：**
- **Claude Code**：Task 工具 + 6 个内置 Agent，Fork 路径共享父 Prompt Cache，Coordinator 模式编排
- **Codex CLI**：单会话多任务并行，无原生子 Agent
- **OpenClaw**：基于渠道的静态路由，非运行时委托
- **GitHub Copilot**：Plan Agent + Git Worktree 隔离执行

**实现方案：** 采用 Tool-as-Agent 模式：
1. 子 Agent 封装为 `task` 工具，LLM 通过 Function Calling 自主决策
2. 两条委托路径：继承（共享父 Prompt+工具池）、独立（自己的 Prompt+受限工具）
3. 3 个内置 Agent：general-purpose / explore / plan
4. `Agent.forked()` 静态工厂创建独立实例
5. 结果结构化回传：status + output + filesModified + toolRounds

**架构层次：**
```
TaskTool → SubAgentRunner → Agent.forked() → 子 Agent Loop
```

**关键设计决策：**
- 上下文隔离：子 Agent 独立 messages，不污染主 Agent
- 不传父 context：防止过期数据 + System Prompt 重复注入
- verbose=false：子 Agent 工具进度不刷终端
- 禁止递归 task：子 Agent 工具集不含 task 工具
- 危险命令拦截：子 Agent 的 sudo/rm -rf 等直接抛错
- Plan Agent 结果美化：按 dependsOn 拓扑分批渲染

**发现并修复的问题：**
1. 每个子 Agent 实例创建 4 次（createAgent 被重复调用 + forked 内部双重 reset）
2. System Prompt 中上下文重复注入 2~3 次
3. 子 Agent 的 sudo 命令未拦截
4. 子 Agent 拿主 Agent 启动时的过期上下文
5. 终端输出信息量失控（verbose 控制双向调整）
6. readline 与流式输出重叠 + resize 丢行

**最终效果：**
- LLM 能自主通过 task 工具触发 plan + 并行多子 Agent
- 实测：WebRTC 项目从规划到完整代码生成，11 步骤计划 + 6 对并行子 Agent，耗时 5:50
- 终端输出干净：子 Agent 静默 + 完成摘要 + 明确结束标记

---

## 8. tool_call_id 缺失导致 API 400 错误

**发现时间：** 2026-06-07

**现象：** `❌ 错误: 400 An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'`

**根因：** 工具执行中途抛异常时，assistant 的 `tool_calls` 已推入 messages，但部分 tool result 未推送。OpenAI API 要求每个 `tool_call_id` 必须有对应的 tool 消息，严格成对校验。

**修复方式：**
1. 串行路径 `executeToolsSerially` 中每个工具独立 try-catch，失败不阻断后续
2. 并行路径 `Promise.all` → `Promise.allSettled`，部分失败不丢结果
3. 兜底：遍历 `response.toolCalls`，未拿到结果的补 `❌ 工具 xxx 执行中断` 占位

**验证：** 改 `MODEL_CONTEXT_LIMIT=28000` 测试压缩，对话中出现 113%→57% 的上下文缩减，compressHistory 生效确认。

---

## 10. Plan 模式升级 — dependsOn 并行执行

**发现时间：** 2026-06-10

**需求：** 规划 Agent 输出的步骤自然有依赖关系，无依赖的步骤应该并行执行。

**方案：**
1. `PlanStep` 新增 `dependsOn: number[]` 字段
2. `executeStepsParallel()` 按依赖拓扑分批：每批次内步骤 `Promise.all` 并发
3. `buildDependencyBatches()` 贪心算法构建批次
4. `generateSteps` 的 Prompt 升级为输出带 dependsOn 的 JSON

**关键：** dependsOn 信息只在 PlanAgent → PlanManager 路径中被 `buildDependencyBatches` 消费。LLM 自主调用 task(plan) 路径时，dependsOn 只是文本提示，不影响并行调度（由 LLM 自己推理分批）。

---

## 11. 全局 CLI + 终端输出优化

**发现时间：** 2026-06-10

**需求：** 项目只能在源码目录通过 pnpm dev 启动，无法作为全局命令在其他目录使用。

**方案：**
- `bin/mini-agent.ts`：Global CLI 入口（env 加载 → 转发 src/index.ts）
- `package.json` 加 `bin` 字段，`pnpm link --global` 安装
- 支持 `--workspace` / `--model` 参数
- 工作区 `.env` 优先，项目 `.env` 兜底

**终端优化：**
- `rl.pause()` / `rl.resume()`：释放终端给流式输出
- `process.stdout.on("resize")`：处理终端 resize 防丢行
- `verbose=false`：子 Agent 静默，不刷 ⏳/✓
- `printSummary`：子 Agent 完成时输出一行摘要（📋 计划名 — N步骤 [X轮]）
- `✅ 完成` 标记：每次回复后明确显示结束

**踩坑：** `Config` 对象在 import 时静态捕获 `process.env`，所以 bin 入口必须先 `loadEnv` 再 `await import("../src/config.js")`，否则 API Key 永远是空字符串。