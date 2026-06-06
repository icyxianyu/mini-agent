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

