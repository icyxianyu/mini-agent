# TODO — Mini Claude Code

## 已完成

- [x] **对话** — LLM 集成，支持自然语言交互
- [x] **文件读写** — 8 个工具（read/write/edit/delete/copy/move/list_dir/create_dir）
- [x] **执行终端命令** — execute_command 工具，超时 + 输出截断
- [x] **流式输出** — SSE streaming，逐 token 打印 + tool_calls 碎片拼装
- [x] **日志系统** — 原始数据记录，毫秒时间戳 + 完整 API 请求/响应

---

## 推荐路线（学习价值排序）

### 1. 内容搜索工具 `search_content`

> "找出所有使用了 `useState` 的文件"、"搜索 TODO" — Agent 自己找代码位置

- [ ] `search_content` 工具（正则/文本搜索）
- [ ] 搜索结果分页截断
- [ ] 与 `read_file` 配合：搜索→定位→读取→编辑

### 2. 并行工具调用

> LLM 一次返回多个 tool_calls 时并行执行，速度翻倍

- [ ] `Promise.all(toolCalls.map(execute))` 代替串行 for
- [ ] 处理多个 tool result 的日志顺序

### 3. 上下文注入

> 启动时自动收集项目信息，LLM 天然"知道项目长什么样"

- [ ] 收集：目录结构、git 状态、package.json、.gitignore
- [ ] 编码进 system prompt，控制 token 预算

### 4. Workspace 作用域

> 限制所有文件操作在项目根目录内，安全边界

- [ ] 配置 `WORKSPACE_ROOT`
- [ ] 工具层路径校验（resolve → 检查前缀）
- [ ] 相对路径自动补全为工作区相对路径

### 5. 工具确认模式

> 写/删/执行命令前，先问用户"是否允许"

- [ ] `execute` 返回前查策略表
- [ ] 危险操作分级（读=无需确认，写=确认，删=强制确认）
- [ ] REPL 中等待 Y/n 输入

### 6. 错误恢复

> 工具失败时 Agent 能自动重试或换方案

- [ ] 工具失败时写入 messages 的结构优化
- [ ] LLM 基于错误信息自动调整策略
- [ ] 重试次数限制

### 7. 会话持久化

> 关闭终端后下次打开能接着上次对话

- [ ] 保存/加载 messages 历史
- [ ] 绑定到工作目录的 session 文件

---

## 扩展想法（长期）

- [ ] **Web UI** — React 前端代替终端 REPL
- [ ] **MCP 协议** — 接入外部工具服务器
- [ ] **子 Agent** — 复杂任务拆给多个 Agent 并行处理
- [ ] **多模型切换** — 运行时动态选择模型
- [ ] **Token 计数** — 实时显示每轮消耗的 token
