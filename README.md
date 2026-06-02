# Mini Claude Code

> 简易版 Claude Code — 一个用于学习 **AI Agent 架构** 的 TypeScript 项目。

核心能力：**对话**、**文件操作**、**执行终端命令**。麻雀虽小，五脏俱全——架构和真正的 Claude Code 是同一套模式。

---

## 目录

- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [架构设计（核心）](#架构设计核心)
  - [整体：五层架构](#整体五层架构)
  - [层次 1：配置层](#层次-1配置层)
  - [层次 2：LLM 客户端层](#层次-2llm-客户端层)
  - [层次 3：工具层](#层次-3工具层)
  - [层次 4：Agent 核心循环层](#层次-4agent-核心循环层)
  - [层次 5：交互层](#层次-5交互层)
- [完整交互流程](#完整交互流程)
- [为什么 Agent 模式能工作？](#为什么-agent-模式能工作)
- [可用工具列表](#可用工具列表)

---

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 配置 API Key
cp .env.example .env
# 编辑 .env，填入你的 LLM_API_KEY

# 3. 启动
pnpm dev
```

支持所有兼容 OpenAI API 接口的模型（OpenAI / DeepSeek / 通义千问 / vLLM ..）。

---

## 项目结构

```
agent/
├── src/
│   ├── index.ts              # 入口：REPL 交互循环
│   ├── config.ts             # 配置管理（API Key、模型等）
│   ├── logger.ts             # 日志模块（记录完整交互过程）
│   ├── llm.ts                # LLM 客户端（封装 API 调用）
│   ├── core.ts               # ★ Agent 核心循环（编排 LLM ↔ 工具）
│   └── tools/
│       ├── base.ts           # 工具基类（接口定义）
│       ├── file-tools.ts     # 8 个文件操作工具
│       ├── shell-tools.ts    # 终端命令执行工具
│       └── index.ts          # 工具注册表（汇总所有工具）
├── logs/                     # 运行时生成的日志
├── .env.example              # 配置模板
├── package.json
└── tsconfig.json
```

只有 6 个源文件，每个职责单一明确。

---

## 架构设计（核心）

### 整体：五层架构

```
┌─────────────────────────────────────────────────────────┐
│                   交互层 (index.ts)                      │
│              REPL：读用户输入 → 调用 Agent → 输出回复      │
├─────────────────────────────────────────────────────────┤
│                 Agent 核心循环 (core.ts)                  │
│        维护对话历史，编排 LLM 思考 ↔ 工具执行的循环        │
├──────────────────────┬──────────────────────────────────┤
│   LLM 客户端 (llm.ts) │       工具层 (tools/)            │
│   封装 API 调用       │    read_file, write_file, ...   │
│   区分文本/工具调用    │    统一 ToolResult 返回格式       │
├──────────────────────┴──────────────────────────────────┤
│                   配置层 (config.ts)                      │
│           从 .env 读取，提供全局应用配置                    │
└─────────────────────────────────────────────────────────┘
```

**为什么用五层而不是一个大文件？**

每一层只做一件事，任何一层的修改不影响其他层。比如：
- 想换模型（DeepSeek → GPT）→ 只改 `.env`，代码不动
- 想加新工具（比如执行终端命令）→ 在 `tools/` 下加一个文件
- 想换交互方式（REPL → Web UI）→ 只改 `index.ts`

---

### 层次 1：配置层

**文件**：`src/config.ts`

```
从 .env → 读取 → Config 单例 → 所有模块引用
```

所有配置集中管理，提供 `validate()` 确保必需项存在。切换 LLM 厂商只需改环境变量。

---

### 层次 2：LLM 客户端层

**文件**：`src/llm.ts`

这是和 AI 模型的"翻译官"，负责把对话发给 LLM，拿到回复。

**核心概念 — LLM 的两种回复：**

```
┌──────────────────────────────────────────────────┐
│               LLM 回复的两种情况                    │
│                                                    │
│  情况 A: 纯文本回复                                │
│  ┌─────────────────────────────┐                  │
│  │ LLMResponse {              │                  │
│  │   content: "main.ts 的内容是"│                  │
│  │   toolCalls: []  ← 空      │                  │
│  │ }                          │                  │
│  └─────────────────────────────┘                  │
│                                                    │
│  情况 B: 请求调用工具                               │
│  ┌─────────────────────────────┐                  │
│  │ LLMResponse {              │                  │
│  │   content: null            │                  │
│  │   toolCalls: [{            │                  │
│  │     name: "read_file",     │                  │
│  │     arguments: {           │                  │
│  │       file_path: "main.ts" │                  │
│  │     }                      │                  │
│  │   }]                       │                  │
│  │ }                          │                  │
│  └─────────────────────────────┘                  │
└──────────────────────────────────────────────────┘
```

**关键技术 — Function Calling**

当传给 LLM 的 `tools` 参数有值时，LLM 会**自主判断**是否需要用工具。这和"强制调用"不同——LLM 可以选择直接文本回复（不需要工具时），也可以选择调用工具后再回答。这就是 `tool_choice: "auto"` 的含义。

**为什么抽象成 LLMResponse？**

上层 Agent 不需要关心具体是 OpenAI 还是 DeepSeek——它只看 `LLMResponse` 的 `content` 和 `toolCalls` 字段来处理分流。这就是**面向接口编程**。

---

### 层次 3：工具层

**文件**：`src/tools/base.ts`（接口定义）+ `src/tools/file-tools.ts`（8 个实现）

```
┌──────────────────────────────────────────────┐
│          BaseTool (接口)                      │
│                                              │
│  · name         → LLM 用来调用的标识符        │
│  · description  → 帮助 LLM 理解"什么时候用"   │
│  · parameters   → JSON Schema 格式的参数定义  │
│  · toOpenAISchema() → 转成 Function Calling  │
│  · execute()    → 真正执行，返回 ToolResult   │
└──────────────┬───────────────────────────────┘
               │ 实现
    ┌──────────┼──────────┬──────────┬─────────┐
    ▼          ▼          ▼          ▼         ▼
ReadFile   WriteFile  EditFile  DeleteFile  ...
```

**为什么用接口（interface）而不是类继承？**

TypeScript 中 interface 更灵活——不强制继承关系，只要对象结构匹配就能传。这意味着未来可以增加非类实现的工具（比如函数式工具）。

**ToolResult 统一返回格式：**

```typescript
{ success: true, content: "文件内容..." }
{ success: false, content: "", error: "文件不存在" }
```

Agent 不关心工具内部如何实现，只看 success/content。这保证了**工具和 Agent 的解耦**。

**toOpenAISchema() 的作用：**

这是工具"自述书"，告诉 LLM：我叫什么、干什么用的、需要什么参数。LLM 读了这份说明书后，就能自主决定何时调用哪个工具。

---

### 层次 4：Agent 核心循环层

**文件**：`src/core.ts`

这是整个项目的**大脑**，实现了 Agent 模式的核心逻辑。

**Agent Loop 详细流程：**

```
用户: "读一下 index.ts 的内容"
  │
  ▼
┌──────────────────────────────────────────┐
│  Agent.chat(userInput)                   │
│                                          │
│  Step 1: 用户消息 → messages            │
│  [{role:"user", content:"读一下..."}]    │
│                                          │
│  Step 2: 发给 LLM (带 tools)            │
│  LLM 回复: { toolCalls: [read_file] }   │
│                                          │
│  Step 3: 执行 read_file("src/index.ts") │
│  结果: "文件内容是: /**\n * 主入口..."   │
│                                          │
│  Step 4: 结果加入 messages，再发给 LLM  │
│  [{role:"tool", content:"文件内容是..."}]│
│                                          │
│  Step 5: LLM 收到结果，生成文本回复     │
│  LLM 回复: "index.ts 的内容是: ..."     │
│                                          │
│  Step 6: 文本回复展示给用户              │
└──────────────────────────────────────────┘
```

**为什么需要一个循环？**

LLM 每次调用工具后，需要**看到工具返回的结果**才能继续推理。这个过程：

```
用户 → LLM 思考 → 需要工具 → 执行工具 → 结果回给 LLM → LLM 再思考 → 需要更多工具？→ ...
```

可能多轮，也可能一轮就够。Agent Loop 用 for 循环 + 最大轮数限制来处理这个不确定性。

**消息历史维护是关键：**

OpenAI API 要求消息格式严格对应。当 LLM 请求工具调用时，必须：
1. 先加一条 `assistant` 消息（带 `tool_calls` 字段）
2. 再加 `tool` 消息（带 `tool_call_id` 对应回 assistant）

这两条消息必须**成对出现**，否则 API 报错。Agent 的 `formatToolCallsMessage()` 方法负责正确构造这些消息。

**MAX_TOOL_ROUNDS 防护：**

如果没有这个限制，LLM 可能：
- 反复读取同一个文件（死循环）
- 工具返回错误后不停重试
- 陷入"调用→失败→再调用"循环

达到上限后，Agent 强制要求 LLM 给出纯文本最终回复。

---

### 层次 5：交互层

**文件**：`src/index.ts`

最上层，只做三件事：
1. 验证配置 → 创建 Agent
2. 进入 REPL 循环（read-eval-print-loop）
3. 处理特殊命令（`/help` `/reset` `/exit`）

用 `chalk` 美化终端输出，`readline` 实现异步输入。

---

## 完整交互流程

以"帮我创建一个 hello.ts"为例，展示各层如何协作：

```
时间线 →

index.ts              core.ts               llm.ts              tools/
  │                     │                     │                   │
  │ "创建 hello.ts"     │                     │                   │
  │────────────────────▶│                     │                   │
  │                     │ chat(messages,tools)│                   │
  │                     │────────────────────▶│                   │
  │                     │                     │ OpenAI API        │
  │                     │                     │──────────         │
  │                     │                     │         │         │
  │                     │ LLMResponse{toolCalls:[write_file]}    │
  │                     │◀────────────────────│                   │
  │                     │                     │                   │
  │                     │ executeTool("write_file", {path,content})
  │                     │────────────────────────────────────────▶│
  │                     │                     │   fs.writeFile()  │
  │                     │◀────────────────────────────────────────│
  │                     │ "文件已写入: hello.ts"                   │
  │                     │                     │                   │
  │                     │ chat(messages+result,tools)             │
  │                     │────────────────────▶│                   │
  │                     │                     │ OpenAI API        │
  │                     │ LLMResponse{content:"已创建 hello.ts"}  │
  │                     │◀────────────────────│                   │
  │                     │                     │                   │
  │ "已创建 hello.ts"   │                     │                   │
  │◀────────────────────│                     │                   │
  │                     │                     │                   │
```

一次用户输入 → Agent 内部可能 2 轮 LLM 调用（第 1 轮决定用工具，第 2 轮基于结果回复）。

---

## 为什么 Agent 模式能工作？

**核心洞察**：LLM 本身只是一个"文本预测器"，它不能直接操作文件。但给它一套"工具说明书"（Function Calling），它就能：

1. 理解你的需求
2. 判断需要哪个工具
3. 生成工具调用的参数
4. 看到工具结果后，用自然语言解释给你

这就像给了 AI "手脚"——**大脑（LLM）负责决策，手脚（Tools）负责执行**。Agent Loop 就是连接大脑和手脚的神经系统。

三条关键设计原则：
- **LLM 自主决策**（`tool_choice: "auto"`）— 不是写死调用哪个工具，而是让 AI 自己判断
- **结果反馈** — 工具执行结果必须回到 LLM，形成闭环
- **循环防护** — 防止 AI 陷入死循环

---

## 可用工具列表

| 工具 | 触发方式（自然语言示例） |
|------|-------------------------|
| `read_file` | "读一下 app.ts" |
| `write_file` | "创建一个 config.ts 文件" |
| `edit_file` | "把 app.ts 里的 foo 改成 bar" |
| `delete_file` | "删除 temp.txt" |
| `copy_file` | "复制 a.ts 到 b.ts" |
| `move_file` | "把 old.ts 重命名为 new.ts" |
| `create_directory` | "创建 src/utils 目录" |
| `list_directory` | "看看当前目录有什么" |
| `execute_command` | "跑一下 npm test"、"git status" |

**你不需要记住工具名**——用自然语言描述需求，LLM 会自动匹配正确的工具。
