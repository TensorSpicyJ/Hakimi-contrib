# Research 模式

Hakimi 的 v2 引擎默认启用 Research 模式，并内置 AITP 的记忆、研究、写作、方法提炼和交互学习 Skills。课题的 `research.md` 与它链接的推导、代码、文献和结果就是科研记忆；Hakimi 保存当前选中的笔记、模式开关和 Goal 原先关联的笔记路径，不维护另一份科学总结。

## 打开课题

在已有课题目录启动 Hakimi。它会查找最近的 `research.md`，展示标题、开头的主线概括和附近的分课题。使用 `/research` 浏览，`/research status` 查看当前主线，`/research back` 返回父课题；也可用 `/research <笔记路径>` 选择已有 Markdown 或 TeX 主文档。目录参数选择其中的 `research.md`。

在终端的空输入框按 `←` 可打开课题目录，再进入会话中的 Agent 列表查看委派工作；输出期间按 `←` 直接进入 Agent 目录。也可随时使用 `/research agents` 查看前台和后台委派；在 Agent 详情按 `←` 返回目录，再按 `←` 或 `Esc` 返回输入框。Web 对话上方显示主线摘要，展开后可预览主文档、进入子课题或返回父课题；查看子 Agent 时可直接返回主 Agent。

选择课题只改变会话的研究焦点，不改变工具的工作目录。界面和上下文中的笔记路径标明实际课题位置。分课题仍按 AITP 使用普通目录和相互链接的主文档，不要求固定标题、目录模板或额外台账。不存在主文档时，先由 `aitp-memory` 判断是否需要建立持久课题；一个独立问题不会自动生成文件夹。

## 聚焦研究问题

每个新轮次、Goal 自动续跑和上下文压缩后的恢复都会重新提供选定主文档的有限摘录。完整推导和证据仍按需读取，正文改动会在后续上下文中体现。`MEMORY.md`、`memory.md` 和 `memory_summary.md` 不会被当作科研主文档自动发现，也不能选作课题主笔记。项目的 `AGENTS.md` 编码约束继续生效。

Research 模式使用现有的 Goal 和 `Agent` 工具。协调者根据问题选择 `research-theory`、`research-code`、`research-literature`、`research-review` 或 `research-writing`，并为委派任务说明问题、输出位置、验收证据和停止边界。文献和审查角色只读；写作角色只编辑获分配的文档。子 Agent 共享选定课题，结果由协调者核对后整合回主文档，不会各自开启持续 Goal。

科研角色复用现有 [Agent 预设](../customization/agents.md) 的模型和思考配置。理论依次回退到 `physicist`、`thinker`；代码使用 `coder`；文献依次使用 `librarian`、`explore`；审查和写作使用 `thinker`。活动预设或 `[subagent.agents]` 中显式设置的 `research-*` 字段优先；缺失字段才按上述顺序回退，最终继承主 Agent。Research 模式不会指定供应商或强制思考等级。恢复已有子 Agent 时使用相同路由；通过 `AgentSwarm` 委派时，显式 `swarm` 路由仍保留原有优先级。

内置的 AITP Skills 保留原有职责；LibRPA 代码任务还可使用 `developing-librpa`。Skill 的参考文件可以通过 `Read` 按需读取。Tower 的隔离代码工作区只在适合代码任务时使用，不是每个科研问题必须经历的流程。

有 Agent 或后台任务运行，或 Goal 处于活动状态时，切换课题和模式会被拒绝。先暂停 Goal 并等待运行中的工作结束，再切换。选中的主文档丢失时，Goal 自动续跑会等待处理，不会自行选一个不同的问题。

Goal 会保留创建时的课题路径。暂停后可以浏览和选择其他课题，但恢复旧 Goal 时，若当前课题不同，续跑会停在等待状态而不请求模型。返回原课题再恢复，或用 `/goal replace` 明确建立新课题的目标。

## 设置与范围

`/research off` 为当前会话关闭模式，`/research on` 恢复。Web 提供相同开关。为新会话修改默认值：

```toml
[research]
enabled = false
```

`KIMI_CODE_EXPERIMENTAL_RESEARCH=0` 可关闭自动课题锚定。模式关闭后，内置 AITP Skills 和科研角色仍可显式调用。现有 v1 回退引擎不提供新模式。

Research 模式帮助保留问题、证据和工作边界，不能自动保证推导正确或数值收敛。小模型检验通过不能代替真实材料计算，也不能把有限尺寸的守恒关系升级为任意尺寸的定理。最终结论及其适用条件仍需在 `research.md` 中结合证据说明。
