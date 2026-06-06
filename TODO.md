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
- [x] 错误恢复：分类提示（ENOENT/EACCES/TIMEOUT）+ parse error 重试
- [x] 会话管理：workspace 隔离 + 多会话 + list/load/new/delete 命令

## 已完成 扩展功能
- [x] **Token 计数**：API usage 提取 + 终端展示 + 累计统计


---

## 计划

> 按依赖关系排列。被依赖的在前，依赖者在后。

### Token 计数 ✅
*被「上下文窗口管理」「Plan 模式」依赖*

- 非流式从 `response.usage` 读，流式最后 chunk 获取
- 终端显示本轮消耗 + 累计统计

### 网络重试
*无依赖*

- 5xx/timeout/network error 自动重试 3 次，指数退避 1→2→4s
- 4xx 不重试，流式和非流式都覆盖

### 大文件分段
*无依赖*

**背景**：实测发现 LLM 即使搜到行号也不主动用 offset/limit，完整读文件浪费大量 token。
**方案**：不改 LLM 行为，改工具默认行为——read_file 不指定 offset 时默认只返回前 200 行。

- read_file 默认上限 200 行（可配置 `READ_FILE_DEFAULT_LIMIT`）
- 超出部分展示总行数提示 + offset 翻页用法
- 上下文注入已读过的文件部分不重复收 token
- 对 LLM 透明：参数和接口不变，只是默认行为更保守

### Shell 安全分级
*无依赖*

- `rm -rf`、`git push --force`、`sudo`、`chmod 777` 危险检测
- 确认提示中额外 ⚠️ 警告，模式列表可 .env 配置

### 流式进度
*无依赖*

- LLM 发起 tool_call 后终端显示执行状态，完成后追加 ✓ 或 ✗
- 不打断后续流式文本输出

### 上下文窗口管理
*依赖「Token 计数」*

- 每轮估算总 token，超模型上限 80% 时自动裁剪
- 策略：保留 system + 最近 5 轮 + 旧轮次 LLM 自摘要

### 编辑预览
*无强制依赖*

- edit_file 执行前纯 JS 行对比，彩色终端展示 diff
- 确认升级为 `[Y] 应用 [n] 取消 [v] 完整 diff`

### search_content 提速
*无强制依赖*

- 检测系统有 rg 时切换 ripgrep（10~100x），无则 fallback 纯 JS
- 工具名和参数对 LLM 透明

### Web 内容获取
*无强制依赖*

- `fetch_url` 工具：HTTP GET → 提取正文 → Markdown
- 5s 超时，1MB 上限，去掉 script/style/nav

### 项目规则配置
*参考「上下文窗口管理」*

- `.mini-agent/rules.md`，启动时注入 system prompt
- /reset 自动重载，`/rules edit` 编辑

### 框架检测
*增量修改 context.ts*

- package.json 依赖识别 react/vue/next/nuxt/express/django 等
- 追加到 system prompt：`框架: React 18 + TypeScript + Vite`

### 运行时模型切换
*无强制依赖*

- `/model <name>` 切换当前会话模型，不影响历史
- 预设列表 `.mini-agent/models.json`，支持别名

### diff/patch 编辑
*依赖「编辑预览」*

- 用 unified diff 替代字符串精确匹配
- LLM 生成 patch → apply，行号偏移 ±5 容忍，失败回滚

### Plan 模式
*依赖「Token 计数」「上下文窗口管理」*

- 复杂任务生成 numbered checklist，保存 `.mini-agent/plans/`
- 终端进度显示，失败自主重试/跳过/修改
- `/plan status` `/plan cancel`

### 子 Agent 委托
*依赖「上下文窗口管理」「Plan 模式」*

- 主 Agent 拆分 → 并行分配子 Agent，独立 messages + 工具
- 共享工作区，子任务失败不阻塞

### Skill 系统
*无强制依赖（框架级）*

- `.mini-agent/skills/` 下 skill 包定义工具 + prompt + 触发条件
- 启动加载注册，`/skill list` `/skill reload`

### 多模态输入
*需模型支持 vision*

- `read_image` 工具：本地图片 → base64 → image_url 消息
- 超大图自动压缩到模型限制

### MCP 协议
*无强制依赖（框架级）*

- MCP client（stdio + HTTP），`.mini-agent/mcp.json` 配置
- MCP 工具和内置工具统一注册表

### Web UI
*依赖前面所有（最后一步）*

- React + TypeScript，四面板：对话 | 文件树 | 终端 | 日志
- WebSocket/SSE 通信，终端和 Web 共用 Agent 核心
