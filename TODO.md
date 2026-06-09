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
- [x] Shell 安全分级：`rm -rf`/`git push --force`/`sudo`/`chmod 777` 危险检测，⚠️ 警告，模式列表可 .env 配置
- [x] 网络重试：5xx/timeout/429 自动重试 3 次，指数退避；4xx 不重试，流式+非流式都覆盖
- [x] 错误恢复：分类提示（ENOENT/EACCES/TIMEOUT）+ parse error 重试
- [x] 会话管理：workspace 隔离 + 多会话 + list/load/new/delete 命令
- [x] 流式进度：工具调用时终端显示 ⏳ 执行状态，完成后追加 ✓/✗，不打断后续流式输出

## 已完成 扩展功能
- [x] **Token 计数**：API usage 提取 + 终端展示 + 累计统计（非流式从 `response.usage` 读，流式最后 chunk 获取）
- [x] **大文件分段**：read_file 默认上限 200 行（可配置），超出展示总行数 + offset 翻页提示，对 LLM 透明
- [x] **上下文窗口管理**：每轮估算 token，超模型上限 80% 时 LLM 自摘要旧轮次，保留 system + 最近 5 轮
- [x] **精确 Token 计数**：用 gpt-tokenizer 的 encodeChat 替代字符数/4 估算，偏差从 -26% 降到 0%
- [x] **低轮次压缩修复**：不足 5 轮时允许压缩（保留至少 1 轮），避免早期超大上下文撑爆
- [x] **Web 内容获取**：fetch_url 工具，HTTP GET → HTML 提取纯文本，5s 超时，1MB 上限
- [x] **工具结果预算管理**：middle truncation 硬截断（256 行 / 10KiB）+ Microcompact 旧 tool_result → `[Old tool result content cleared]` 占位符，对齐 Claude Code/Codex，零 API 调用
- [x] **Plan 模式**：Agent 自主探索 → 步骤拆解 → 终端确认 → 逐步执行，失败自动重试/skip，`.mini-agent/plans/` 持久化，三层架构分离（REPL→Plan→Agent）
- [x] **search_content 提速**：优先 ripgrep（10~100x），不可用则 fallback 纯 JS，execFileSync 非 shell 传参，工具参数对 LLM 透明


---

## 计划

> 按学习价值 + 依赖关系排列。Agent 架构核心概念优先。

### 子 Agent 委托
*依赖「上下文窗口管理」「Plan 模式」*

- 主 Agent 拆分 → 并行分配子 Agent，独立 messages + 工具
- 共享工作区，子任务失败不阻塞

### Skill 系统
*无强制依赖（框架级）*

- `.mini-agent/skills/` 下 skill 包定义工具 + prompt + 触发条件
- 启动加载注册，`/skill list` `/skill reload`

### MCP 协议
*无强制依赖（框架级）*

- MCP client（stdio + HTTP），`.mini-agent/mcp.json` 配置
- MCP 工具和内置工具统一注册表
- Web 搜索：通过接入 Brave/Tavily Search MCP Server 实现，解决国内网络限制

### 编辑预览
*无强制依赖*

- edit_file 执行前纯 JS 行对比，彩色终端展示 diff
- 确认升级为 `[Y] 应用 [n] 取消 [v] 完整 diff`

### diff/patch 编辑
*依赖「编辑预览」*

- 用 unified diff 替代字符串精确匹配
- LLM 生成 patch → apply，行号偏移 ±5 容忍，失败回滚

### 运行时模型切换
*无强制依赖*

- `/model <name>` 切换当前会话模型，不影响历史
- 预设列表 `.mini-agent/models.json`，支持别名

### 项目规则配置
*参考「上下文窗口管理」*

- `.mini-agent/rules.md`，启动时注入 system prompt
- /reset 自动重载，`/rules edit` 编辑

### 框架检测
*增量修改 context.ts*

- package.json 依赖识别 react/vue/next/nuxt/express/django 等
- 追加到 system prompt：`框架: React 18 + TypeScript + Vite`

### 多模态输入
*需模型支持 vision*

- `read_image` 工具：本地图片 → base64 → image_url 消息
- 超大图自动压缩到模型限制

### Web UI
*依赖前面所有（最后一步）*

- React + TypeScript，四面板：对话 | 文件树 | 终端 | 日志
- WebSocket/SSE 通信，终端和 Web 共用 Agent 核心
