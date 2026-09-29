# Hakimi implementation plan

状态：`active`。本文件描述当前产品和平台工作，不是历史 AITP 集成的路线图。`GOAL.md` 是 Goal mode 行为规格，保持独立。

## Current tracks

| 轨道 | 名称 | 主要边界 |
| --- | --- | --- |
| A | Web | `apps/kimi-web` production source、桌面/浏览器 Web、schema v5 `dist-web` provenance。 |
| B | 手机远程 | responsive Web/PWA、远程部署、安全与恢复交互。 |
| E | UI 与设置 | TUI、Web、mobile 的设置、双语、可访问性和 workflow authoring/inspection UX。 |
| F | 平台与基础功能 | v2 canonical runtime、上游吸收、共享 contract/gate、Tower workflow runtime、release/CI。 |
| G | DeepSeek 专属适配 | `packages/kosong` provider 层的专用适配与 DeepSeek Harness 吸收。 |

## Architecture baseline

- 默认 runtime 是 `agent-core-v2`；`packages/agent-core` 是冻结的 legacy runtime、rollback 路径和兼容性契约来源。新产品能力进入 v2。
- `[subagent]` 与 `/preset` 是 Agent、AgentSwarm 与 Tower 的 canonical 模型控制面。UI 只消费公开 klient/SDK、REST/WS、wire/event 和 transcript contract，不导入 v2 内部实现。
- `apps/kimi-web` 是唯一可编辑的 production Web source。`apps/kimi-code/dist-web` 与 `web-base.json` 是 canonical command 生成的派生产物，必须与其 provenance 一起验证。
- 需要跨进程、远程恢复或 UI 更新的状态通过可重放 event、wire 或 transcript projection 暴露；live、backfill 和 cold restore 必须收敛，并在能力缺失时明确降级。
- 工作流、研究、测试和人工审阅可以使用普通 Goal、Plan、Skill、工具调用和 transcript 能力，但不得声明不存在的专用研究 runtime、账本、自动持久化或后台科研循环。

## Delivery order

F 先维护共享 runtime、session、permission、transcript、config、release 和 import-boundary gate。A、B、E、G 仅在这些稳定 contract 上交付各自职责；跨轨通过 versioned contract、REST/WS、klient/SDK 或明确贡献点集成，不做 deep import。

### A — Web

A 负责 `apps/kimi-web` 及其打包、branding、serving 和 schema v5 provenance。它只消费 `/api/v1` REST/WS、transcript、klient/SDK 和 F 提供的公开 contract；不实现 workflow validator、model route、merge gate 或 engine service。

### B — mobile and remote

B 在 responsive Web/PWA 和受认证的远程部署上工作。生产远程路径只使用 `/api/v1` REST/WS 和 transcript，不依赖 debug surface、未认证 reverse proxy 或本地 canonical store。

### E — UI and settings

E 负责跨 surface 的信息架构、settings navigation、form/presentation、validation display、loading/error/degraded state、双语与 accessibility。业务 schema、默认值、校验和持久化由 domain owner 通过公开 contract 提供；E 不建立第二套业务状态机。

### F — platform and workflow runtime

F 负责上游 intake、v2 canonical runtime、CLI/TUI/native print 基础、release/CI、安全与性能，以及共享 Tower workflow contract/runtime。每个 upstream window 都记录 base commit，并将改动分类为直接吸收、v2 adapter、legacy-only、overlay conflict 或拒绝。

Workflow 必须有版本、能力、权限和 import-boundary gate；模板与 `.tower/` runtime state 分离。活动日志不是长期知识库，workflow artifact 也不替代 session/transcript contract。

### G — DeepSeek adapter

G 的专用语义限制在 `packages/kosong` provider adapter 层。它不改变 provider 核心抽象，也不回归 GPT/Kimi 路径；缓存、请求组装和压缩纪律由 v2 平台层维护。

## Historical AITP retirement

遗留 AITP adapter、Research Mode、`/research`、相关 REST/SDK/klient API、模型工具、TUI/Web Board 与 Manager 已移除。AITP 仅可作为独立安装的 Skill-only plugin，通过 Hakimi 的常规 plugin discovery、系统提示词和 `Skill` 工具路径使用。Hakimi 不提供 AITP CLI、ledger adapter、session hook、自动写入、特殊 plugin 处理或自定义工具族。

历史设计和兼容性记录保留在 `docs/aitp/`，仅供审计；它们不构成当前工作项或外部 AITP checkout 的修改声明。

## Acceptance evidence

每项工作在合并前应提供与其边界相符的测试、typecheck/build、公开 contract、恢复/降级路径和必要的可访问性证据。禁止通过未定义的 generic public facade、第二 ledger、第二 model router、UI 私有状态机或 production debug endpoint 绕过这些边界。
