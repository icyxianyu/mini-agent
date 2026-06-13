# Mini Claude Code

> 简易版 Claude Code — 一个用于学习 **AI Agent 架构** 的 TypeScript 项目。

核心能力：**对话**、**文件操作**、**终端命令**、**内容搜索**、**子 Agent 委托**、**Skill 系统**。13 个工具 + 流式输出 + 日志 + 全局 CLI。

📋 [开发计划 TODO](TODO.md) · 📝 [问题记录 RECORD](RECORD.md)

---

## 目录

- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [架构设计（核心）](#架构设计核心)
  - [五层架构](#五层架构)
  - [子 Agent 委托](#子-agent-委托)
- [可用工具列表](#可用工具列表)
- [全局 CLI](#全局-cli)

---

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 配置 API Key
cp .env.example .env
# 编辑 .env，填入 LLM_API_KEY

# 3. 启动 REPL
pnpm dev

# 4. 或全局安装为 CLI 命令
pnpm link --global
mini-agent
```

支持所有兼容 OpenAI API 接口的模型（OpenAI / DeepSeek / 通义千问 等）。

---

## 项目结构

```
agent/
├── src/
│   ├── index.ts              # 入口：REPL 交互循环
│   ├── config.ts             # 配置管理（含 System Prompt）
│   ├── context.ts            # 上下文注入（项目类型检测）
│   ├── logger.ts             # 日志模块
│   ├── llm.ts                # LLM 客户端（流式 + 非流式）
│   ├── core.ts               # ★ Agent 核心循环 + Agent.forked()
│   ├── plan.ts               # Plan 模式（步骤分解 + 并行执行）
│   ├── session.ts            # 会话管理
│   ├── tools/
│   │   ├── base.ts           # 工具基类 + ToolResult
│   │   ├── file-tools.ts     # 8 个文件操作工具
│   │   ├── shell-tools.ts    # Shell 命令 + 危险检测
│   │   ├── search-tools.ts   # ripgrep/纯 JS 搜索
│   │   ├── web-tools.ts      # HTTP GET 抓取
│   │   ├── task-tool.ts      # ★ 子 Agent 委托工具
│   │   ├── skill-tool.ts     # ★ Skill 激活工具
│   │   └── index.ts          # 工具注册表 (13 个工具)
│   ├── agents/
│   │   ├── types.ts          # SubAgentConfig / SubAgentResult
│   │   ├── builtin.ts        # 3 个内置 Agent 定义
│   │   ├── runner.ts         # SubAgentRunner 运行时引擎
│   │   └── index.ts          # 模块导出
│   └── skill/
│       ├── types.ts          # SkillMeta / SkillDefinition
│       ├── loader.ts         # 扫描 + YAML frontmatter 解析
│       ├── manager.ts        # 注册/查询/匹配/注入
│       └── index.ts          # 模块导出
├── bin/
│   └── mini-agent.ts         # 全局 CLI 入口
├── test/
│   ├── prompts.md            # 测试用例
│   └── runner.ts             # 测试运行器
├── .env.example
├── package.json
└── tsconfig.json
```

---

## 架构设计（核心）

### 五层架构

```
┌─────────────────────────────────────────────────────────┐
│                   交互层 (index.ts)                      │
│              REPL：读用户输入 → 调用 Agent → 输出回复      │
├─────────────────────────────────────────────────────────┤
│                 Agent 核心循环 (core.ts)                  │
│        维护对话历史，编排 LLM 思考 ↔ 工具执行的循环        │
│        提供 Agent.forked() 创建独立子 Agent               │
├──────────────────────┬──────────────────────────────────┤
│   LLM 客户端 (llm.ts) │       工具层 (tools/)            │
│   流式/非流式 API     │   13 个工具，含 task 子 Agent     │
├──────────────────────┴──────────────────────────────────┤
│                   配置层 (config.ts)                      │
│                     .env → 全局配置                       │
└─────────────────────────────────────────────────────────┘
```

### 子 Agent 委托

**核心概念 — Tool-as-Agent 模式**：

将子 Agent 封装为标准的 Function Calling 工具（`task`），LLM 通过工具调用自主 spawn 子 Agent：

```
主 Agent Loop:
  LLM → tool_calls: [{name:"task", args:{subagent_type, prompt}}]
       │
       ▼
  TaskTool.execute()
       │
       ▼
  SubAgentRunner.run(type, prompt)
       │
       ├─ inherit 路径: 共享父 Prompt + 工具池(过滤)
       ├─ independent 路径: 自己的 Prompt + 受限工具集
       │
       ├─ Agent.forked() → 独立 messages + 独立 Loop
       │
       └─ SubAgentResult → 注入主 Agent messages
```

**三条委托路径**：

| 类型 | 委托方式 | 工具 | 用途 |
|------|---------|------|------|
| general-purpose | 继承 | 全部(禁递归task) | 重构、多文件操作 |
| explore | 继承+过滤 | 只读 | 项目分析、代码搜索 |
| plan | 独立 | 只读+规划Prompt | 制定实施计划 |

**并行执行**：同一 LLM 轮次中的多个 `task` 调用自动 `Promise.allSettled` 并发。

**上下文隔离**：子 Agent 拥有独立的 messages 历史，不污染主 Agent；不注入过期/重复的上下文。

**安全**：禁止嵌套 task（防无限递归）；子 Agent 内的 sudo/rm -rf 等危险命令自动拦截。

### Skill 系统

**SKILL.md 格式** — YAML frontmatter + Markdown body：

```markdown
---
name: 技能名称
description: 触发条件描述，LLM 用于语义匹配
---

# 技能指令正文...
```

**渐进式披露**：启动时只加载 `name + description` 注入 System Prompt（~100 tokens/skill），LLM 匹配后通过 `skill` 工具激活，完整 body 按需加载。

**三种使用方式**：
- `/skill list` — 查看所有已加载 skill
- `/skill <name>` — 手动激活
- LLM 自动匹配 — 当用户需求命中 skill 的 `description` 时，LLM 通过 `skill` 工具自主激活

**支持可执行脚本**：skill 目录下 `scripts/` 放可执行脚本，skill 指令中引用执行。

```
.mini-agent/skills/<name>/
├── SKILL.md
└── scripts/
    └── setup.sh
```

---

## 可用工具列表

| 工具 | 分类 | 说明 |
|------|------|------|
| `read_file` | 只读 | 读文件，支持 offset/limit |
| `write_file` | 写入 | 创建/覆盖文件 |
| `edit_file` | 写入 | 精确字符串替换 |
| `delete_file` | 删除 | 删除文件 |
| `copy_file` | 写入 | 复制文件 |
| `move_file` | 写入 | 移动/重命名文件 |
| `create_directory` | 写入 | 递归创建目录 |
| `list_directory` | 只读 | 列出目录内容 |
| `search_content` | 只读 | ripgrep 内容搜索 |
| `execute_command` | 执行 | 终端命令 |
| `fetch_url` | 只读 | HTTP GET 获取网页 |
| `task` | 委托 | ★ 启动子 Agent |
| `skill` | 委托 | ★ 激活 Skill 获取指令 |

---

## 全局 CLI

```bash
# 安装
cd <项目目录> && pnpm link --global

# 使用
mini-agent                        # 启动 REPL（默认 cwd 为工作区）
mini-agent -w /path/to/project    # 指定工作区
mini-agent -m deepseek            # 临时覆盖模型
mini-agent "一句话任务"            # 单次执行后退出
```
