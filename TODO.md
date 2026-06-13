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
- [x] **子 Agent 委托 (Tool-as-Agent)**：task 工具封装子 Agent，LLM 自主 spawn，独立 messages + 工具集，3 个内置 Agent（general-purpose/explore/plan），继承/独立两条路径，并行执行，危险命令拦截，结果结构化回传
- [x] **全局 CLI**：`mini-agent` 命令，`pnpm link --global` 安装，`--workspace` / `--model` 参数，自动加载 .env，REPL + 单次执行
- [x] **终端优化**：readline pause/resume、resize 处理、子 Agent 静默、完成标记

---

## 计划

> 按学习价值 + 依赖关系排列。

### Skill 系统
*无强制依赖（框架级）*

- `.mini-agent/skills/` 下 skill 包，SKILL.md 格式（YAML frontmatter + Markdown body）
- 启动加载注册，渐进式披露（启动时只加载 metadata，匹配后加载完整 body）
- LLM 通过 description 语义自动匹配 + 用户手动 `/skill <name>` 调用
- `/skill list` `/skill reload` 命令

### MCP 协议
*无强制依赖（框架级）*

- MCP client（stdio + HTTP），`.mini-agent/mcp.json` 配置
- MCP 工具和内置工具统一注册表

### 编辑预览
*无强制依赖*

- edit_file 执行前纯 JS 行对比，彩色终端展示 diff

### diff/patch 编辑
*依赖「编辑预览」*

- unified diff 替代字符串精确匹配，行号偏移 ±5 容忍

### 运行时模型切换
*无强制依赖*

- `/model <name>` 切换模型，预设列表 `.mini-agent/models.json`

### 项目规则配置
*参考「上下文窗口管理」*

- `.mini-agent/rules.md`，启动时注入 system prompt

### 框架检测
*增量修改 context.ts*

- package.json 依赖识别框架，追加到 system prompt

### 多模态输入
*需模型支持 vision*

- `read_image` 工具：本地图片 → base64

### Web UI
*依赖前面所有（最后一步）*

- React + TypeScript，四面板：对话 | 文件树 | 终端 | 日志
- WebSocket/SSE 通信，终端和 Web 共用 Agent 核心

---

## 优化
*工具量上去后再做，现阶段收益不大*

- **动态工具挂载**：根据对话阶段动态决定暴露哪些工具（简单对话不挂、代码阅读只挂只读、复杂任务挂全部），等 MCP/Skill 把工具数推到 30+ 才有价值
- **Skill 条件激活**：`paths` 字段按操作文件路径匹配激活 skill，skill 数量 20+ 时减少选择噪声
- **Skill Fork 模式**：不必要——现有 task 工具已能子 Agent 隔离执行
- **终端输出重构**：REPL + 流式 + 工具进度三者争 stdout 是架构固有限制，Web UI 做完后彻底消失
