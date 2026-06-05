# TODO — Mini Claude Code

## 已完成

- [x] **对话** — LLM 集成，支持自然语言交互
- [x] **文件读写** — 8 个工具（read/write/edit/delete/copy/move/list_dir/create_dir）
- [x] **执行终端命令** — execute_command 工具，超时 + 输出截断
- [x] **流式输出** — SSE streaming，逐 token 打印 + tool_calls 碎片拼装
- [x] **日志系统** — 原始数据记录，毫秒时间戳 + ✦ 新增标记 + 边框分组
- [x] **内容搜索** — search_content，纯 JS 递归 + 正则，自动跳过 node_modules
- [x] **并行工具调用** — Promise.all 并行执行多工具，加速比 1.6~3x
- [x] **上下文注入** — 启动时检测项目类型（9 种），收集配置/入口/README/Git
- [x] **Workspace 作用域** — 所有文件操作限制在 WORKSPACE_ROOT 内
- [x] **工具确认模式** — Y/n/a/s 四种选项，读操作无需确认
- [x] **错误恢复** — 结构化错误信息 + 分类提示，引导 LLM 自动恢复
- [x] **会话持久化** — /exit 自动保存，启动时自动恢复，.mini-agent/session.json

---

## 扩展想法（长期）

- [ ] **Web UI** — React 前端代替终端 REPL
- [ ] **MCP 协议** — 接入外部工具服务器
- [ ] **子 Agent** — 复杂任务拆给多个 Agent 并行处理
- [ ] **多模型切换** — 运行时动态选择模型
- [ ] **Token 计数** — 实时显示每轮消耗的 token
