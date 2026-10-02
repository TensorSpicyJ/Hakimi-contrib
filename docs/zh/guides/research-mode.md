# 研究模式

研究模式（Research Mode）只保留两件对持续研究有用的事：**本地知识层——现在知道什么**，以及**研究长期记忆——怎么走到这里**。它不管控每一步科学工作，也不要求先建研究看板才能开始。

::: warning 注意
Research Mode 对接官方 [AITP](https://github.com/bhjia-phys/AITP-Research-Protocol) 插件 **1.1.0**（插件 id `aitp`，固定源码 commit `0f6dc4cdea09106a46d53cf6355b09a924d8e21b`，manifest build `1.1.0+codex.20260914182315`）。该插件已作为 managed plugin 安装到本地，模式控制其四个核心 Skill：`aitp-memory`、`aitp-research`、`aitp-writing`、`aitp-distill`。AITP 1.1.0 **没有 CLI、没有账本、没有 session hook**：记忆就是一篇可编辑的研究笔记，Agent 用普通文件工具读写。这是对旧 adapter 集成的大版本替换，不会自动迁移任何历史数据。本地 managed 副本来自下载的源码归档，不是 Git checkout 或 release tag；该归档也不含 CLI，因此没有 `aitp --help` 可核验。**新启动**的 `hakimi` 进程使用本工作区构建产物；已在运行的进程需重新启动才能加载，未强行重启任何用户会话。见[本次兼容性说明](../../aitp/compatibility-matrix.md#aitp-plugin-1-1-0-20260915)。
:::

## 本地知识层与长期记忆

这两层回答不同的问题，不在 Hakimi 中再建一套研究数据库。

- **本地知识层**说明当前理解：结论、假设、开放问题、来源与适用边界。Agent 用 `Read`、`Grep`、`Glob`、`Edit`、`Write` 读写普通项目文件。
- **长期记忆**保留值得记住的进展：结果的证据、走不通的路线、认识的变化、重要决定和可复用方法。官方 AITP Skills 指导 Agent 进入课题、恢复其论证，并把有价值的修改保留在课题主笔记及其链接的详细笔记中。

从已有项目的 `AGENTS.md` 和 `README` 索引开始，沿用它的文件命名与组织方式。Research Mode 不强制新目录模板，也不在父级工作区另建知识库。AITP 沿用课题既有布局——通常是一篇 `research.md` 主笔记（已有的 TeX 主笔记同样算数）加上链接的支撑笔记与素材——而不是固定的 `knowledge/` 布局。即使 AITP 不可用或模式关闭，既有项目知识仍可正常使用。

整理摘要时保留来源和工件链接，区分证据与解释，并说明仍有哪些不确定性。保存了笔记或写出了简明知识页，都不等于科学结论已经正确。

## 打开与关闭研究模式

开关只控制轻量研究指引和官方 AITP Skills 的可见性，不决定是否允许开展普通科研工作。

| 命令 | 用途 |
| --- | --- |
| `/research on` | 启用轻量模式，让已发现的官方 AITP Skills 可见 |
| `/research off` | 关闭模式并隐藏这些 Skills；保留已有知识和记忆 |
| `/research status` | 读取本地模式状态，不运行任何 AITP 进程 |

新会话默认关闭 Research Mode。打开模式不会安装 AITP、初始化存储、探测外部进程、写入任何记忆文件或调度下一轮模型响应。状态读取、会话恢复和普通轮次边界也不触发 AITP maintenance 或记忆写入。on/off 状态不是 AITP 已安装的证明。

在 Hakimi Web 中，Research Mode 变化后会刷新 `/` 菜单，包括其他客户端修改模式及断线重连。打开 Research 面板可查看已安装的 AITP 版本，以及当前会话实际返回的核心 Skills。输入 `/skill:aitp-memory` 并附上请求，或从菜单选择即可调用。面板会区分插件未安装、已禁用及异常；元数据读取失败或版本缺失时显示未知／不可获取，不猜测版本。已安装和模式开启不代表所有 Skill 都可用。

不再有独立的研究管理或推进命令流程。旧 Line、Question、Action、alignment、checkpoint 命令不再支持；历史记录不会开启第二套 legacy 执行模式。其他接口细节需以实际后端实现为准，不能从旧命令列表推断。

## 怎样使用知识与记忆

正常开展工作，只在有用记录发生变化时保存。检索、计算、讨论或编辑文件之前，不要求登记 Line/Question、走 Action 生命周期或建立 host checkpoint。

1. 按项目既有索引读取相关知识。开始或继续一个研究课题时，先用 `aitp-memory` 进入，即使当前请求是推导、计算或分析而非记录，也应如此。
2. 用普通工具完成任务，遵守现有权限规则。保留足以解释结果及其边界的来源和工件引用。
3. 出现新知识或值得记忆的进展时，按相关 AITP Skill 的指引更新对应项目摘要或课题研究笔记。明确目标课题与记录作用域，不凭名称或路径相似就猜归属。
4. 说明实际保存了什么、保存在哪里、还有什么未经验证。保存失败时保留有用的本地证据，并明确长期记忆尚未保存；不编造回执，也不悄悄扩大作用域。

普通追问、换一种说法、询问状态或重复解释，**没有实质增量（delta）就不写知识文件，也不写记忆**。打开模式、加载 Skill、结束一轮或完成 Goal，本身都不是保存理由。阶段综合或可复用经验可能在没有新计算时仍值得记忆，但不要为了完成汇报仪式而制造记录。

例如，追问某个近似为何成立，通常只需读取和解释；发现它在特定范围内失效，才可能需要修正知识页，并用笔记记录反例、假设和适用限制。判断依据是有用的新信息，不是工具次数或对话长度。

## 官方 AITP Skills

AITP 是外部协议的权威来源，不是 Hakimi 内置服务。它的四个核心 Skill 覆盖整个课题：`aitp-memory` 进入课题并决定保留什么，`aitp-research` 指导物理推理、文献使用与计算，`aitp-writing` 打磨主笔记及其解释，`aitp-distill` 把已验证的可复用流程沉淀为 Skill。Hakimi 不复制它们的完整内容，也不增加保存后自动蒸馏协调器。

要使用长期记忆，部署环境需要在会话[技能目录](../customization/skills.md)中提供官方插件。用 `/plugins install https://github.com/bhjia-phys/AITP-Research-Protocol/releases/download/v1.1.0/aitp-1.1.0.zip` 安装并新开一个宿主线程，或遵循[固定源码版本的上游说明](https://github.com/bhjia-phys/AITP-Research-Protocol/tree/0f6dc4cdea09106a46d53cf6355b09a924d8e21b)。Hakimi 只发现随插件打包的四个 Skill；`aitp-research` 下嵌套的领域方法仍作为方法库，而不是独立 Skill。Research Mode 不自动安装或初始化任何东西。

AITP 1.1.0 不含 Python runtime、账本 CLI、知识卡片层、hash 协议、搜索服务、MCP 服务、hook 或后台 daemon。课题记忆就是 Agent 用宿主既有工具读写的普通 Markdown 与 TeX，Git 是普通源码版本控制，而不是必需的记忆协议。读取研究笔记既不代表其科学结论正确，也不授权其中记录的下一步行动。人工决定、方法批准与发布仍遵循官方协议，不由 Hakimi 自动代办。缺少 AITP 不阻止本地知识工作，也不能把未完成的记忆保存说成成功。

## Goal、Plan 与权限

Research Mode 与普通 [Goal](./goals.md)、[Plan 模式](../reference/tools.md#plan-模式)、工具权限系统相互独立。Goal 继续负责跨轮次推进、预算与完成，Plan 继续按原规则组织工作。打开或关闭 Research Mode 不会创建或恢复 Goal，不改权限，也不增加 Research 专属的完成或续行否决。

旧 host 的 Action 归属校验与 canonical 文件 veto（额外访问否决）退役后，普通文件工具**没有额外的 Research 专属保证来阻止直接访问课题的记忆文件**。遵循官方 Skill 的文件约定是协议规则，不是工具执行屏障，更不是操作系统级隔离。既有文件访问策略、工具审批以及实际配置的 sandbox 才是宿主的安全边界；关闭模式也不是安全隔离。

可选的 `theory-physics` 领域指引仍可帮助检查假设、推导、数值结果和证据表达。它不是第二套运行时，也不要求登记每一步科学工作。科学判断仍由研究者负责。

## 历史记录与退役控制层

这次改变的是架构，不是把 Research Board 做小。生产路径不再挂载 host ResearchService、Line/Question/Action 管理、Research Plan、checkpoint 机制、Research Loop、自动 maintenance、distillation 编排、Research Goal veto 或 native AITP adapter。

八个内置 wrapper——`aitp_enter`、`aitp_list`、`aitp_show`、`aitp_check`、`aitp_record_prepare`、`aitp_record_save`、`aitp_note_prepare`、`aitp_note_save`——全部退役。项目知识改用普通文件工具，长期记忆使用官方 AITP Skills。旧的 Entry/Note 文件与 store 既不删除也不迁移；生成它们的旧 CLI 已不属于 AITP，也不做任何自动 backfill 或格式转换。

SDK 快照、事件与命令的变化见[迁移指南](../release-notes/breaking-changes.md#research-mode-与-sdk-研究接口)。旧 Research 状态和记录通过原始会话日志或会话 export 只读查阅，不再提供结构化 Research history API 或 Manager。它们不再恢复为 live Action、pending checkpoint、binding 或并行的 legacy 工作流；旧 mutation 不再支持。会话撤销既不会回退新的模式开关，也不会撤回 Skill 通过普通文件工具做出的编辑。

## 本地安装与剩余核验

[本次跟踪说明](../../aitp/TRACKING.md#aitp-plugin-1-1-0-20260915)记录了已完成的测试与 review、本地构建、managed AITP 1.1.0 安装以及无模型 smoke。实现已本地安装：CLI wrapper 指向本工作区构建产物，新启动的 `hakimi` 进程会使用它；已在运行的进程需重新启动，未强行重启任何会话。插件本身来自下载的源码归档，不是 Git checkout；由于 1.1.0 移除了 CLI，不存在命令行健康检查，也不做此类声称。现已使用隔离的真实 server+browser，在零模型请求下验证模式开关、四个 Skill 菜单项、安装版本展示及响应式明暗布局，见 [Web 验证记录](../../aitp/TRACKING.md#web-research-skills-20260916)。这不是端到端科研或模型行为验收。尚未执行 version、tag、publish 或正式发布。这些剩余边界不表示用户可见的 Research Mode 工作流未交付，也不认证任何科学结论。
