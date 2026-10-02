# 会话与上下文

Hakimi 把每次对话持久化为一个「会话」，保留消息历史和元数据，可以随时关闭终端后再回来继续。本页介绍如何恢复会话、管理上下文，以及导出和派生会话。

## 会话存储

所有会话保存在 `$KIMI_CODE_HOME/sessions/` 下（默认 `~/.hakimi/sessions/`），按工作目录分组存放：

```text
~/.hakimi/
├── config.toml
├── session_index.jsonl
└── sessions/
    └── <workDirKey>/
        └── <sessionId>/
            ├── state.json
            └── agents/
                ├── main/
                │   └── wire.jsonl
                └── <subagentId>/
                    └── wire.jsonl
```

- `state.json`：会话标题、创建时间等元数据。
- `agents/*/wire.jsonl`：Agent 事件流，用于会话恢复和回放；同时记录发给模型的请求轨迹（工具 schema、请求参数、MCP 工具清单），便于调试。

::: warning 注意
`sessions/` 目录下的文件请勿手动编辑，否则可能导致会话无法正常恢复。
:::

## 启动与恢复会话

每次直接运行 `hakimi` 都会创建新会话。以下方式可以恢复历史会话：

**继续当前目录最近的会话：**

```sh
hakimi --continue
```

**恢复指定会话（通过 ID）：**

```sh
hakimi --session abc123
```

**交互式浏览历史会话并选择：**

```sh
hakimi --session
```

::: warning 注意
`--continue` 与 `--session` 互斥。
:::

在桌面 Web UI 中，对话页标题栏会在会话标题旁汇总当前 Git 工作树：分支或 detached HEAD 状态、改动文件数、ahead/behind 数、增删行数和 pull request 状态。点击工作树摘要可打开改动详情，点击 pull request 状态徽标可打开对应的 pull request。非 Git 仓库不显示该卡片；对话列变窄时，它会按优先级逐步隐藏次要指标。

## 在 TUI 中切换会话

不离开当前终端也可以管理会话，以下斜杠命令仅在 Agent 空闲时可用：

- **`/new`**（别名 `/clear`）：切换到新会话，丢弃当前上下文。
- **`/sessions`**（别名 `/resume`）：浏览并恢复历史会话。
- **`/fork`**：派生当前会话（详见下文）。
- **`/title <text>`**（别名 `/rename`）：设置会话标题方便识别；不带参数时显示当前标题。

## 跨项目交接任务

main agent 可以在另一个项目创建独立会话并提交首条任务，不必由你复制 prompt。这项功能在终端界面和 Web 中默认开启。需要独立会话时，Agent 可以主动说明目标项目与任务，询问你是否同意，得到确认后再创建并启动；如果你已经明确要求这次交接，就不重复询问。

无需设置环境变量即可使用。如需关闭，可以设置 `KIMI_CODE_EXPERIMENTAL_CROSS_PROJECT_SESSIONS=false`，或在 `[experimental]` 下设置 `cross_project_sessions = false`。

目标必须是运行 Hakimi 的电脑上已有且受信任的项目目录，并且需要配置默认模型。随后明确说明目标目录和任务：

```
在 /path/to/project-b 创建一个新会话，检查它的 API 兼容性。
带上刚才讨论的约束和验收条件，并在那里启动任务。
```

Agent 会通过 [`StartSession`](../reference/tools.md#跨项目会话) 传递自包含的任务说明。工具调用遵循正常审批规则，Plan 模式下不可用。目标会话加载自身项目的指令和新会话默认设置，不复制你的聊天历史、当前权限覆盖或临时目录授权。如果项目信任检查失败，应先打开并信任该项目，而不是让 Agent 绕过检查。

在 Web 中，目标会话会出现在对应项目的会话列表里，不会把你从当前对话切走。打开它即可跟进任务并回答它的审批请求或问题。在终端界面中，`/sessions` 为本进程通过这种方式启动的会话提供独立查看面板，查看或关闭面板都不会关闭任一会话。如果有待处理的审批或问题，需要先回答才能打开 `/sessions`。目标会话的审批和问题面板会标明所属项目；对某个会话的授权不会扩大到其他会话。

工具会报告 prompt 已接受、启动、被拦截、失败、取消或已完成等实际状态；拿到会话 ID 不代表任务成功。创建成功但启动失败时，应检查现有目标会话，不要自动再建一个。目标任务独立于来源会话的轮次运行，但不独立于宿主进程：请保持原终端界面或 Web server 运行。关闭宿主会停止正在执行的工作，已持久化的历史仍可稍后恢复。Print 模式和未接入交接会话交互能力的宿主不会提供该工具。

## 从其他设备远程控制

Web 远程控制可以让手机或另一台电脑通过互联网使用 Hakimi Web。当前电脑仍是服务器：Hakimi 在 `127.0.0.1` 上打开一个经过鉴权的完整 Web listener，再由 `cloudflared` 通过临时 Cloudflare Quick Tunnel 暴露它。不需要 VPS、Tailscale、Cloudflare 账号或公网入站端口。

Hakimi Web 默认提供这个功能：

1. 安装官方 [`cloudflared` 二进制文件](https://developers.cloudflare.com/tunnel/downloads/)。Hakimi 不会自动下载或更新它。
2. 启动本地 Web server：

   ```sh
   hakimi web
   ```

3. 打开任意会话，直接点击对话标题栏中始终可见的**远程控制**按钮；在移动端 Web 中，点击顶部栏的 globe 按钮。
4. 需要临时分享时，保持选中**临时分享**，选择 30 分钟、1 小时、8 小时或 24 小时，再点击**开始远程控制**。
5. 需要 Linux 长期访问时，切换到**长期运行**，即可在同一对话框中启动或停止后台服务，并查看当前 health、URL 和二维码。

链接会先打开本地 Web UI 中选中的会话，随后提供与本地 Web 相同的工作区和会话导航。在窄屏手机上，顶部栏及其会话切换和设置 Bottom Sheet 会提供会话操作、subagent preset、Git 和 PR 信息，以及后台 Agent、Bash 和任务输出，不需要桌面宽度的多栏布局。

共享期间，对话标题栏会显示**远程**徽标，点击即可重新打开对话框。点击**停止远程控制**会立即关闭 tunnel；TTL 到期、`cloudflared` 退出或本地 Web server 停止时也会自动关闭。远程页面不会显示创建另一个 tunnel 的控件。

临时分享不会直接暴露主 listener。Hakimi 会创建第二个回环 listener：它复用当前 runtime，只接受临时凭据，并提供完整的鉴权 Web 数据面。

对于 Linux 上的长期个人访问，Hakimi 可以通过 `systemd --user` 服务保持一个独立的 Quick Tunnel 运行。该流程没有 TTL，也不要求 `hakimi web` 一直开启：

```sh
hakimi remote start
hakimi remote status
hakimi remote stop
```

`hakimi remote start` 会安装并启用用户服务，启动一个完整的全会话 Web listener，并打印 URL 和二维码。`hakimi remote status` 会再次打印当前 URL，并分别报告本地服务健康状态和隧道就绪状态；不提供隧道健康信息的旧版运行服务会显示 `unknown`。`hakimi remote stop` 会禁用并停止服务，但保留 `~/.hakimi/remote/` 下的私有配置和控制 token，供下次启动复用。该服务会随 Linux 用户会话启动，并在进程意外退出后自动重启。

后台服务还能检测到 `cloudflared` 进程仍在运行、但与 Cloudflare 的连接已经丢失的情况。启动后最多等待 60 秒建立首个就绪连接，此后每 5 秒检查一次就绪状态，连续三次失败便重启服务。检查成功会清零失败次数，因此短暂中断不会立即触发重启。运行 `journalctl --user -u hakimi-remote.service` 可以查看故障原因和经过脱敏、长度受限的近期隧道日志；就绪检查不能保证公网域名从所有网络均可访问。

后台服务会在重启后继续使用同一个控制 token，但 Quick Tunnel 不提供固定 hostname。同一个 `cloudflared` 进程持续运行时，`*.trycloudflare.com` 地址通常保持不变；重启 `cloudflared`、重启服务或重启电脑都会产生新地址。请在宿主电脑上运行 `hakimi remote status` 获取替换后的链接。

TUI 仍保留从所选会话 handoff 的流程。打开会话并等待 Agent 空闲，然后直接运行 `/remote`，无需设置环境变量。前台远程 server 接管前，TUI 会关闭会话并退出，因此不会有两个 runtime 同时写入同一会话。链接会先打开该会话，但随后可在 Web UI 中访问所有工作区和会话。在原终端按 `Ctrl-C` 可以停止它。`/remote` 是面向用户的命令，接管用的底层子命令仍保持内部隐藏。

Web 和 TUI 分享的默认 TTL 是 8 小时，最大为 24 小时。Web 提供固定选项；TUI 还接受自定义正时长，例如 `/remote --ttl 30m` 或 `/remote --ttl 1d`。如果 `cloudflared` 不在 `PATH` 中，请在启动 Hakimi 前设置 `KIMI_CODE_CLOUDFLARED_PATH`；在 TUI 中也可以传入 `/remote --cloudflared /absolute/path/to/cloudflared`。

::: danger 警告
生成的 URL 在 fragment 中包含控制 token。任何拿到完整 URL 或二维码的人都能完整访问这台电脑上的 Hakimi Web，因此请把它当作密码，不要粘贴到聊天、日志或 issue 中。Web 与 TUI 的分享使用临时 token；后台服务会有意跨重启复用 token，直到你删除它的私有配置。
:::

通过鉴权后，远程 Web 可以新建、重命名、归档、切换和控制会话；修改配置、模型、供应商、OAuth 和 plugins；上传、浏览和下载文件；并显示媒体、本地路径、工具输入、审批细节以及完整的 Agent、Bash 和任务输出。Tunnel listener 仍不会注册 PTY 终端、debug、server shutdown 或嵌套远程控制路由。

Cloudflare 明确说明，[Quick Tunnels 不提供 SLA 或 uptime 保证，仅用于测试与开发](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)。该模式适合短时间个人使用或少量可信用户，不适合生产可用性要求。如果需要稳定域名、访问策略、审计控制或 uptime 承诺，请使用托管 tunnel 或其他部署服务。

## 上下文压缩

对话变长时，Hakimi 会在上下文接近窗口上限时自动压缩历史消息，释放 token 空间。也可以随时手动触发：

```
/compact
```

压缩时可以附带指引，告诉模型优先保留哪些信息：

```
/compact 保留与数据库迁移相关的讨论
```

可选的 `context_continuity` [实验开关](../configuration/config-files.md#experimental)要求压缩模型交接当前目标、用户约束、决策、验证证据和未完成工作。压缩前会准备降噪后的历史副本，并在溢出重试中保护真实用户输入和最新交接摘要。工具调用与结果保持配对；若无法安全缩小请求，压缩会失败，并保留原有历史。

这仍是模型生成的压缩，不保证记忆无损。原有的用户消息限额保留机制继续生效；未被原文保留的细节依赖生成摘要。长会话后应核对关键事实。该开关使用现有的跨供应商压缩路径，不会启用 OpenAI 原生 compaction，也不会将供应商的不透明内容当作摘要。关闭开关即可恢复原有压缩策略。

两种策略下，压缩响应被拒绝或过滤时都会失败并保留可恢复的历史，不会把这类结果当成摘要，也不会删减约束后重试。

## 派生会话

想在不破坏当前对话的前提下尝试新思路，使用 `/fork`：

```
/fork
```

fork 后你仍停留在原会话，对话不受影响、可以直接继续；派生出的副本与原会话彼此独立，可以随时通过 `/sessions` 切换过去。已保存的 `/goal` 不会复制到派生会话。如果你想在派生会话中进行自主 goal 工作，需要在那里开始一个新 goal。

fork 完成后，CLI 会打印一条可直接运行的 `hakimi --resume` 命令（并自动复制到剪贴板），方便你在新终端进程中直接进入派生会话。

## 导出会话

用 `hakimi export` 把会话打包为 ZIP，适合分享、归档或提交问题反馈：

```sh
hakimi export <sessionId>
```

不传 `sessionId` 时导出当前目录最近的会话（有交互式确认，加 `-y` 跳过）。用 `-o` 指定输出路径：

```sh
hakimi export <sessionId> -o ~/Desktop/my-session.zip
```

导出包含会话目录下的所有文件，包括诊断日志。全局诊断日志（`~/.hakimi/logs/kimi-code.log`）默认也会打包；如不需要，加 `--no-include-global-log` 排除。

也可以在 TUI 内导出，无需离开交互界面：

- **`/export-debug-zip`**：产生与 `hakimi export` 相同的调试 ZIP。
- **`/export-md`**（别名 `/export`）：导出为人类可读的 Markdown 对话记录，适合分享或存档。可选接收路径参数；不带参数时写入工作目录下的 `kimi-export-<short-id>-<timestamp>.md`。

在 web UI 中，`/export` 会把当前会话下载为诊断 ZIP。压缩包包含持久化的会话数据、诊断日志，以及记录浏览器关键事件且大小有上限、只含元数据的 `logs/kimi-web.jsonl`；提示词正文、WebSocket 内容和 console 参数不会写入这份浏览器日志。这里的 web 命令与上面的 TUI `/export` 别名行为不同。

::: tip 提示
导出文件可能包含代码、命令输出和路径等敏感信息，分享前请先确认内容。
:::

## 下一步

- [数据路径](../configuration/data-locations.md) — 会话文件的完整目录结构说明
- [hakimi 命令](../reference/kimi-command.md) — `--continue`、`--session`、`export` 等命令的完整参数参考
