# TODO — Mini Claude Code

## 已完成 基础功能

- [x] 对话交互：流式 + 非流式，OpenAI/DeepSeek 多模型
- [x] 文件操作：read/write/edit/delete/copy/move/list_dir/create_dir + 工作区校验
- [x] 终端命令：execute_command，超时 + 输出截断
- [x] 流式输出：SSE streaming，tool_calls 碎片拼装
- [x] 日志系统：毫秒时间戳，✦ 新增标记，完整 API 请求/响应
- [x] 内容搜索：search_content，正则 + 自动跳过 node_modules
- [x] 并行执行：Promise.all，1.6~3x 加速
- [x] 上下文注入：9 种项目类型检测，配置/入口/Git/README 自动收集
- [x] 安全机制：路径防越界 + 工具风险分级确认（Y/n/a/s）
- [x] Shell 安全分级：危险检测，模式列表可 .env 配置
- [x] 网络重试：5xx/timeout/429 重试 3 次指数退避；4xx 不重试
- [x] 错误恢复：分类提示 + parse error 重试
- [x] 会话管理：workspace 隔离 + 多会话 + list/load/new/delete
- [x] 流式进度：工具调用终端显示 ⏳ 执行状态，完成后追加 ✓/✗

## 已完成 扩展功能

- [x] **Token 计数 + 精确计数**：gpt-tokenizer encodeChat，终端展示上下文占用 vs 窗口上限
- [x] **大文件分段**：read_file 默认上限 200 行，超出提示翻页
- [x] **上下文窗口管理**：超 80% 触发 LLM 自摘要压缩，保留 system + 最近 5 轮
- [x] **Web 内容获取**：fetch_url 工具，HTML → 纯文本
- [x] **工具结果预算管理**：middle truncation + Microcompact
- [x] **Plan 模式**：探索 → 步骤拆解 → 确认 → 执行，dependsOn 依赖分析 + 并行执行
- [x] **search_content 提速**：优先 ripgrep，fallback 纯 JS
- [x] **子 Agent 委托 (Tool-as-Agent)**：task 工具封装子 Agent，LLM 自主 spawn，独立 messages + 工具集，3 个内置 Agent，继承/独立两条路径，并行执行，危险命令拦截，结果结构化回传
- [x] **全局 CLI**：`mini-agent` 命令，`pnpm link --global` 安装，`--workspace` / `--model` 参数，自动加载 .env
- [x] **终端优化**：readline pause/resume、resize 处理、子 Agent 静默、完成标记
- [x] **Skill 系统**：SKILL.md 格式（YAML frontmatter + Markdown body），渐进式披露，`skill` 工具 LLM 自主激活，`/skill` 命令，scripts/ 可执行脚本

---

## 计划

> 按学习价值 + 依赖关系排列（顶部优先），Web UI 为最终目标。

### 自我任务管理工具（TodoWrite as a Tool）
*agent 的动态自我编排，区别于 Plan 模式的静态规划*

- `todo_write` 工具 + 内存状态结构，LLM 执行中自主维护 todo list
- 与 Plan 模式互补：Plan = 执行前规划+人确认；本项 = 执行中 agent 自管理
- 学到什么：agent「自我状态管理」范式 · 成本：低

### MCP 协议
*协议底座，杠杆最大 —— 一次接入，第三方能力皆可挂载，独立于 UI*

- MCP client（stdio + HTTP），`.mini-agent/mcp.json` 配置
- MCP 工具和内置工具统一注册表
- Web 搜索能力作为 MCP server 接入（而非内置工具）
- 学到什么：协议抽象 + 工具动态注册 · 成本：中

### 诊断闭环 / LSP 集成（read_lints）
*编辑 → 验证 → 自修复 反馈闭环，Cursor 核心体验*

- 轻量版：跑 `tsc --noEmit` / `eslint` 并解析输出回灌（优先做，价值/成本比最高）
- 重量版：接 LSP 获取实时诊断
- 学到什么：编辑后验证 + 自修复闭环 · 成本：轻量低 / LSP 高

### 后台进程管理（Background Tasks）
*长驻进程的生命周期管理，突破同步阻塞限制*

- `execute_command` 支持 `run_in_background`，启动 dev server / watch
- 进程注册表 + 输出缓冲区 + 查询/终止工具（BashOutput / KillShell 模型）
- 学到什么：进程生命周期、异步输出轮询 · 成本：中

### 任务中断与转向（Interrupt / Steering）
*执行中 ESC 打断并插入新指令，提升交互体验*

- 终端消息队列 + AbortController 中断 LLM 流 / 工具执行
- 复用已有 readline pause/resume 基础
- 学到什么：流式中断 + readline 协调 · 成本：中

### Hooks 系统
*安全 + 自动化，Claude Code 有，我们缺*

- PreToolUse / PostToolUse 钩子，shell 命令或 HTTP 回调
- 场景：提交前强制检查测试通过、危险命令拦截、文件修改后自动 lint

### 运行时模型切换
*零依赖，几分钟的事*

- `/model <name>` 切换模型，预设列表 `.mini-agent/models.json`

### 项目规则配置
*学 CLAUDE.md 精髓*

- `.mini-agent/rules.md`，启动时注入 system prompt

### Session 管理增强
- `--resume` / `--continue` 恢复历史会话

### 语义代码索引（Embedding-based Codebase Search）
*向量化语义检索，Cursor 区别于文本搜索的核心差异化；独立大工程，不挡主线小项*

- 代码分块 chunking + embedding 生成 + 向量库（本地 sqlite + 余弦相似度起步）
- 增量索引更新
- 学到什么：含金量最高的工程模块 · 成本：高

### Web UI
*最终目标 — 解决终端所有限制*

- React + TypeScript，四面板：对话 | 文件树 | 终端 | 日志
- WebSocket/SSE 通信，终端和 Web 共用 Agent 核心

---

## 优化
*收益不大或依赖 UI，工具量/UI 上来后再做*

- **Prompt Caching / 成本优化**：provider 级缓存断点，复用稳定 system prompt + 历史——本质是成本优化，依赖 provider 支持度，现阶段收益不稳定
- **动态工具挂载**：工具数 30+ 时按阶段过滤
- **Skill 条件激活**：`paths` 字段路径匹配，skill 20+ 时减少噪声
- **框架检测**：package.json 依赖识别，追加到 system prompt
- **多模态输入**：`read_image` 工具——终端意义不大，UI 才能发挥
- **diff/patch 编辑**：Web UI 的 diff 体验碾压终端
- **Checkpoint/Undo**：UI 时代用 Git history 实现，更可靠
- **Agent SDK**：Web UI 稳定后暴露 programmatic API
