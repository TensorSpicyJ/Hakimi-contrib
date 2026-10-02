# 配置文件

Hakimi 把所有长期偏好写进 `~/.hakimi/` 下的 TOML（一种结构清晰的纯文本配置格式）文件——比如使用哪个模型、填哪个 API 密钥、Agent 每轮最多跑几步。改一次，每次启动都生效。Agent 与运行时设置放在 `config.toml`，终端界面与客户端偏好（主题、编辑器、通知、自动更新）放在配套的 `tui.toml`。

默认位置：`~/.hakimi/config.toml`，首次运行时自动创建。

## 配置文件位置

CLI 从 `~/.hakimi/config.toml` 读取配置。如需把数据目录迁移到别处，可用 `KIMI_CODE_HOME` 环境变量覆盖（优先级高于默认的 `~/.hakimi`；`HAKIMI_HOME` 优先级最高）：

```sh
export KIMI_CODE_HOME=/path/to/hakimi-home
```

此时配置文件路径变为 `$KIMI_CODE_HOME/config.toml`。无论目录在哪里，文件名固定是 `config.toml`。

::: tip
TOML 字段名一律用下划线（snake_case），如 `default_model`、`max_context_size`。字段名里若含 `.`，需用引号包住，例如 `[models."gpt-4.1"]`——否则 TOML 会把 `.` 解释为嵌套表分隔符。
:::

## 完整示例

以下示例覆盖最常用的配置项，可直接复制后按需修改：

```toml
default_model = "kimi-code/k3"
default_permission_mode = "manual"
default_plan_mode = false
merge_all_available_skills = true
telemetry = true

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = ""

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]
display_name = "K3"
support_efforts = [ "max" ]
default_effort = "max"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]

[models."kimi-code/kimi-for-coding-highspeed"]
provider = "managed:kimi-code"
model = "kimi-for-coding-highspeed"
max_context_size = 262144
capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]

[thinking]
enabled = true
effort = "high"
keep = "all"

[loop_control]
max_attempts_per_step = 10
reserved_context_size = 50000

[background]
max_running_tasks = 4
keep_alive_on_exit = false

[services.moonshot_search]
base_url = "https://api.kimi.com/coding/v1/search"
api_key = ""

[services.moonshot_fetch]
base_url = "https://api.kimi.com/coding/v1/fetch"
api_key = ""

[[permission.rules]]
decision = "allow"
pattern = "Read"

[[permission.rules]]
decision = "deny"
pattern = "Bash(rm -rf*)"

[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "node ~/.hakimi/hooks/check-bash.mjs"
timeout = 5
```

## 顶层字段

配置文件里的字段分两类：**顶层标量**直接控制默认行为，**嵌套表**（`providers`、`models`、`thinking` 等）各有独立结构，在下文各节单独说明。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `default_model` | `string` | — | 默认模型别名，必须在 `models` 中定义 |
| `default_permission_mode` | `string` | `manual` | 新会话的默认权限模式，可选 `manual`（逐次询问）、`yolo`（自动批准工具操作，Agent 仍可能提问）、`auto`（自动批准工具操作并抑制普通对话提问；显式的协议级工作流决策仍可能暂停） |
| `default_plan_mode` | `boolean` | `false` | 新会话是否默认以 Plan 模式（先出计划再执行）启动 |
| `merge_all_available_skills` | `boolean` | `true` | 是否合并所有目录中的 Agent Skills |
| `extra_skill_dirs` | `array<string>` | — | 额外 Skill 搜索目录，叠加到默认目录之上 |
| `extra_agent_dirs` | `array<string>` | — | 额外自定义 Agent 搜索目录，叠加到默认目录之上 |
| `builtin_product_skills` | `boolean` | `true` | 是否向模型提供介绍 Hakimi 自身的内置 Skills：`update-config`、`custom-theme`、`mcp-config`、`check-kimi-code-docs`、`import-from-cc-codex`。关闭后它们的名称和描述不再进入系统提示词，代价是失去这些任务的引导流程。默认的 `agent-core-v2` 引擎会读取本字段；设置 `KIMI_CODE_LEGACY_FLAG=1` 选择旧版引擎时会忽略 |
| `telemetry` | `boolean` | `true` | 是否启用匿名遥测；显式设为 `false` 时关闭 |
| `providers` | `table` | `{}` | API 供应商表 → [`providers`](#providers) |
| `models` | `table` | — | 模型别名表 → [`models`](#models) |
| `subagent` | `table` | — | canonical Agent、AgentSwarm 和 Tower 路由 → [`[subagent]`](#subagent) |
| `secondary_model` | `table` | — | 已废弃的兼容 fallback 和显式 API round-trip 数据 → [`[secondary_model]`](#已废弃的-secondary_model) |
| `thinking` | `table` | — | Thinking 模式默认参数 → [`thinking`](#thinking) |
| `loop_control` | `table` | — | Agent 循环控制参数 → [`loop_control`](#loop-control) |
| `background` | `table` | — | 后台任务运行参数 → [`background`](#background) |
| `tools` | `table` | — | 全局工具开关 → [`tools`](#tools) |
| `image` | `table` | — | 图片压缩参数 → [`image`](#image) |
| `services` | `table` | — | 内置外部服务配置 → [`services`](#services) |
| `permission` | `table` | — | 初始权限规则 → [`permission`](#permission) |
| `hooks` | `array<table>` | — | 生命周期 hook，详见 [Hooks](../customization/hooks.md) |
| `identity` | `table` | — | 自定义 Agent 身份 → [`identity`](#identity) |

以下各节对 `providers`、`models`、`subagent`、`secondary_model`、`thinking`、`loop_control`、`background`、`image`、`services`、`permission` 等嵌套表逐一展开。

## `providers`

`providers` 表的每一项定义一个 API 供应商，以唯一名称为 key。CLI 只从这里读取凭证，**不会**从 shell 环境变量自动取后备值——在终端里 `export KIMI_API_KEY` 不会让供应商自动获得密钥，必须显式写在配置文件里（详见[配置覆盖](./overrides.md#供应商凭证)）。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` | 是 | 供应商类型：`kimi`、`anthropic`、`openai`、`openai_responses`、`google-genai`、`vertexai` |
| `api_key` | `string` | 否 | API 密钥，明文写在配置文件里 |
| `base_url` | `string` | 否 | API 基础 URL |
| `oauth` | `table` | 否 | OAuth 凭据引用（`storage`、`key` 两个字段），由登录流程自动注入，通常无需手写 |
| `env` | `table<string, string>` | 否 | 供应商凭证的备用来源，详见下文 |
| `custom_headers` | `table<string, string>` | 否 | 每次请求附加的自定义 HTTP 头 |

**`env` 子表**：可以把供应商惯用的键名（如 `KIMI_API_KEY`）写在 `[providers.<name>.env]` 里，作为 `api_key` / `base_url` 的备用来源。这个子表**只在配置文件里读取**，不会修改 shell 环境：

```toml
[providers.kimi.env]
KIMI_API_KEY = "sk-xxx"
KIMI_BASE_URL = "https://api.moonshot.ai/v1"
```

优先级：`api_key` 字段 > `env` 子表键 > 两者都缺时启动报错。

## `models`

`models` 表的每一项定义一个模型别名（即 `default_model` 或 `-m` 参数里使用的名称），以唯一名称为 key。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `provider` | `string` | 是 | 使用的供应商名称，必须在 `providers` 中定义 |
| `model` | `string` | 是 | 调用 API 时实际传给服务端的模型 ID |
| `max_context_size` | `integer` | 是 | 最大上下文长度（token 数），必须 ≥ 1 |
| `max_input_size` | `integer` | 否 | 模型声明的单次请求输入上限（当低于总窗口时，如 gpt-5 的 400k 窗口 / 272k 输入）。压缩、上下文溢出检查和用量比率优先使用它；补全预算仍使用总窗口。解析时会被钳制到不超过 `max_context_size` |
| `max_output_size` | `integer` | 否 | 单次请求的输出 token 上限（对应 `max_tokens`）。目前仅 `anthropic` 供应商读取。为 Claude 模型设置后，这个显式值会覆盖内置的服务端最大值 |
| `capabilities` | `array<string>` | 否 | 显式追加的能力标签：`thinking`、`always_thinking`、`image_in`、`video_in`、`audio_in`、`tool_use`。与供应商自动识别的能力取并集，只能追加不能移除 |
| `support_efforts` | `array<string>` | 否 | 模型接受的 Thinking 档位。对 `kimi` 而言，在运行时选择列表外的值会报错；模型解析时若配置值或之前的值不受目标模型支持，会回落到目标模型的 `default_effort`，并将该有效值同步给 UI。支持 Thinking 但没有此字段的 Kimi 模型使用布尔 `on` / `off`。其他 provider 在协议提供原生 effort 字段时会原样传递具体值；协议仅提供等级或 token budget 时，只做必要的格式转换。managed 和 open-platform 刷新可能会改写该字段；如需手动固定，请改用 `[models."<alias>".overrides] support_efforts` |
| `default_effort` | `string` | 否 | 模型的默认 Thinking 档位。managed 和 open-platform 刷新可能会改写该字段；如需手动固定，请改用 `[models."<alias>".overrides] default_effort` |
| `off_effort` | `string` | 否 | 关闭 Thinking 时在线上传输的 effort 编码（如 xai grok 的 `none`）。仅对声明了该编码的模型（catalog 会导入）有意义：设置后选择 Off 会发送这个值而不是省略 effort 字段——对默认就会推理的模型，这是真正关闭推理的唯一方式 |
| `base_url` | `string` | 否 | 模型级端点覆盖（catalog 导入网关模型时写入，这些模型与供应商默认端点不同）。解析时优先于供应商的 `base_url`；仅在与 `protocol` 配合时生效 |
| `display_name` | `string` | 否 | UI 中显示的名称，未设时回退到 `model` |
| `reasoning_key` | `string` | 否 | 仅 `openai` 供应商。当网关用非标准字段名返回推理内容时才需要设置；默认自动识别 `reasoning_content` / `reasoning_details` / `reasoning` |
| `adaptive_thinking` | `boolean` | 否 | 仅 `anthropic` 供应商。强制开启或关闭 adaptive thinking，覆盖按模型名推断的逻辑。省略时自动推断（Claude ≥ 4.6 使用 adaptive） |

别名中含 `.` 时需要加引号：

```toml
[models."gpt-4.1"]
provider = "openai"
model = "gpt-4.1"
max_context_size = 1047576
```

### 模型覆盖项

如果某些用户覆盖需要在 provider-model 刷新后保留，请写到 `[models."<alias>".overrides]`。运行时读取的是 effective 值：有 override 时用 override，否则用顶层字段。

```toml
[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144

[models."kimi-code/kimi-for-coding".overrides]
max_context_size = 131072
display_name = "Kimi for Coding (custom)"
```

`[models."<alias>".overrides]` 接受普通模型字段，例如 `max_context_size`、`max_input_size`、`max_output_size`、`capabilities`、`display_name`、`reasoning_key`、`adaptive_thinking`、`support_efforts`、`default_effort` 和 `off_effort`。不接受身份 / 路由字段：`provider`、`model`、`protocol`、`beta_api` 和 `base_url`。

无需修改配置文件也可以临时切换模型——通过 `KIMI_MODEL_*` 环境变量在内存里合成一个临时供应商，详见[用环境变量定义模型](./env-vars.md#用环境变量定义模型-kimi-model)。

## `[subagent]`

`[subagent]` 是 Agent、AgentSwarm 和 Tower 路由的 canonical 模型控制面。每条路由都可以用 `model` 设置模型别名、用 `thinking_effort` 设置 Thinking 档位；别名必须存在于 [`[models]`](#models) 中。

### canonical subagent 路由

设置 active preset 并定义路由表，例如：

```toml
[subagent]
preset = "fast"

[subagent.agents.explore]
model = "provider/fast"
thinking_effort = "medium"

[subagent.agents.swarm]
model = "provider/swarm"

[subagent.agents.tower_worker]
model = "provider/worker"

[subagent.agents.tower_reviewer]
model = "provider/reviewer"

[subagent.presets.fast.main]
model = "provider/main"
thinking_effort = "high"

[subagent.presets.fast.explore]
model = "provider/fast"
```

这些路由 key 的含义是固定的：

- `main`：激活 preset 时应用的 main agent 模型和 Thinking 设置。TUI 的 `/preset` 命令会让全局 `default_model` 和 `thinking` 与这条路由保持同步；Hakimi Web 聊天 header 中的 Preset 按钮则会把它应用到当前会话或正在编辑的草稿。
- `explore`、`plan`、`coder` 以及其他 profile 名称：所选 subagent profile 使用的 Agent 路由。
- `swarm`：AgentSwarm 的默认路由；swarm 选定的 profile 仍可贡献自己的 profile 路由。
- `tower_worker`：Tower worker 任务使用的模型。
- `tower_reviewer`：Tower reviewer 任务使用的模型。worker 和 reviewer 路由彼此独立。

preset 激活时，路由按以下优先级解析：Agent 使用 `presets.<active>.<profile>` → `agents.<profile>` → 调用方模型和 Thinking 档位；AgentSwarm 使用 `presets.<active>.swarm` → `presets.<active>.<profile>` → `agents.swarm` → `agents.<profile>` → 调用方；Tower 使用对应的 `presets.<active>.tower_worker` 或 `presets.<active>.tower_reviewer` → 对应的 `agents` 路由 → 调用方。没有 active preset 时，会先考虑 `agents` 路由。已配置但无法解析的 canonical 别名会被视为配置错误；inactive preset 的路由不会阻止启动。

Agent 和 AgentSwarm 不再接受逐次派生的 `model` 参数。请通过这些 canonical 路由选择模型；工具调用仍可在适用时通过 `subagent_type` 选择 profile。路由同时用于新派生和 resume，因此普通 profile 路由的修改会影响之后的恢复，而保留的 binding 不会被改写。

### 超时

`timeout_ms` 设置单个 subagent 任务的最长墙钟时间（默认 `7200000`，即 2 小时）。设置为 `0` 表示无超时。环境变量 `KIMI_SUBAGENT_TIMEOUT_MS` 优先于配置值；在 print 模式（`hakimi -p`）下，未显式设置时默认为 `0`。超过 `2147483647`（约 24.8 天）的值会被运行时钳制。

### 自动切换 preset

引擎可以在相关 subagent binding 解析前评估已配置的 preset，并选择评分最高的健康候选。`candidates` 仍表示每位用户保存在本机的优先顺序，但不再是严格的回退链：列表位置只贡献优先级加分；如果较低位置的 preset 在配额、本地可靠性、首 token 延迟、token 用量或路由 / 模型匹配度上明显更好，它可以越级胜出。该行为是实验性的，默认关闭：需要同时启用 `auto_subagent_preset` 实验 flag（见[环境变量](../configuration/env-vars.md#运行时开关)）并在此节设置 `auto_preset.enabled`。在 Hakimi Web 中，**设置 > Agent > 自动切换 Preset** 会同时控制这两个必要设置，并允许编辑本地顺序；会话空闲时不会轮询或修改 preset。该开关显示实际运行状态，因此环境设置或 master flag 覆盖后，显示值可能与已保存值不同。

```toml
[subagent]
preset = "balanced"

[subagent.auto_preset]
enabled = true
manual_lock = false
candidates = ["balanced", "kimi-heavy"]
quota_floor_percent = 25
switch_margin_percent = 10
local_usage_window_ms = 3600000
local_usage_weight_percent = 10
priority_weight_percent = 20
reliability_weight_percent = 20
latency_weight_percent = 10
switch_cooldown_ms = 600000
circuit_breaker_failure_threshold = 3
circuit_breaker_cooldown_ms = 900000
refresh_interval_ms = 300000
query_timeout_ms = 5000
allow_extra_usage = false
role_weights = {}
deepseek_peak_policy = "penalize"
deepseek_peak_penalty = 60
reset_priority_window_ms = 259200000
reset_priority_exponent = 3
reset_priority_max_bonus = 200
```

`auto_preset` 字段说明：

- `enabled`：打开自动评估；默认 `false`。此外还必须启用实验 flag，评估才会运行。
- `manual_lock`：保留当前人工选择并跳过自动评估；默认 `false`。手动激活 preset 会把它设为 `true`。Web 自动选择会清除该锁并立即评估；TUI `/preset auto` 只清除手动锁。
- `candidates`：参与评估的 preset 名称列表，按偏好从高到低排列。列表位置提供线性优先级加分，而不是绝对顺序。缺省时所有已配置 preset 按文件顺序参与。显式空数组表示没有可自动派发的目标：保留已存储的 preset，但拒绝建立新的自动绑定，不会使用候选列表外的 preset。若要继续使用固定 preset 派发，请设置 `manual_lock` 或关闭自动选择。
- `role_weights`：可选的角色权重，例如 `{ coder = 2, reviewer = 2 }`。未指定的角色权重为 1，值必须为有限非负数；零权重角色仍显示。总角色权重为零的 preset 不可选。
- `deepseek_peak_policy`：可选 `block`、`penalize` 或 `off`。`block` 在高峰时段禁用官方 DeepSeek；`penalize` 允许其他条件正常的 DeepSeek 路由，但扣除加权策略分；`off` 不处理高峰时段。显式选择 `penalize` 表示允许高峰时段的付费调用。
- `deepseek_peak_penalty`：`penalize` 模式下每个 DeepSeek 角色的高峰惩罚（默认 `60` 分），必须为有限非负数。这是策略分，不是人民币费用；整体扣分按有效 DeepSeek 角色权重占比汇总。
- `deepseek_avoid_peak_hours`：兼容旧配置，默认 `true`，仅在未指定 `deepseek_peak_policy` 时使用：true 对应 `block`，false 对应 `off`。旧的硬禁用不会未经选择就变成软惩罚。余额证据仍需要 `deepseek_usage`；关闭查询不会被当作账户有余额。
- `quota_floor_percent`：通常保留的订阅剩余额度门槛（`25`）。有效临期额度具有正的指数优先加分时，可以使用低于该保留门槛的剩余额度，但不能绕过任何已耗尽的配额窗口、未知资源证据、能力校验或熔断。
- `reset_priority_window_ms`：订阅重置前进入指数优先策略的窗口（`259200000`，即 72 小时），不超过额度自身声明的周期。只有至少一天的周期参与；5 小时限流窗口不会冒充周额度到期。
- `reset_priority_exponent`：指数曲线系数（`3`）；值越大，加分增长越集中在临近重置的阶段。
- `reset_priority_max_bonus`：逐角色临期优先加分上限（`200` 分，不是配额百分比）。设为 `0` 会同时关闭加分及其保留门槛例外。
- `switch_margin_percent`：当前 preset 健康时，最高分候选必须领先多少分才允许普通切换（`10`）。
- `local_usage_window_ms`：统计本地运行证据的回溯窗口（`3600000`，即 1 小时）。
- `local_usage_weight_percent`：归一化本地 token 用量的最大惩罚（`10`）。
- `priority_weight_percent`：最大优先级加分（`20`）。有多个候选时，从第一名线性递减到最后一名的零分；只有一个候选时，它获得完整加分。
- `reliability_weight_percent`：按置信度修正后的本地失败率最大惩罚（`20`）。
- `latency_weight_percent`：按置信度修正并归一化的首 token 延迟最大惩罚（`10`）。
- `switch_cooldown_ms`：自动切换成功后的进程内冷却时间（`600000`，即 10 分钟）。它会阻止普通评分切换，但不会阻止从不健康的当前 preset 逃生。
- `circuit_breaker_failure_threshold`：连续多少次本地运行失败后打开 provider 熔断器（`3`）。取消的运行不计入，后续成功可提前关闭熔断器。
- `circuit_breaker_cooldown_ms`：熔断器打开后，从最近一次失败起保持不可选的时间（`900000`，即 15 分钟）。
- `refresh_interval_ms`：provider 配额答案在两次派生之间的缓存时长（`300000`，即 5 分钟）；subagent 运行结束时缓存会立即失效。
- `query_timeout_ms`：单个 provider 配额查询的超时（`5000`）。
- `allow_extra_usage`：为 `true` 时，余额为正的 Kimi Extra Usage 钱包可在 plan 配额耗尽时补足：provider 的有效剩余百分比取 plan 窗口最低剩余与钱包剩余份额的较大者。Extra Usage 永远不会被自动消耗；默认 `false` 完全不考虑钱包。钱包本身没有订阅临期加分。原始订阅已耗尽、只有显式允许的钱包使路由可用时，不给予临期奖励；仍可实际消费的订阅可以保留自身有效的临期优先级。

评分覆盖整套 preset，不再只看下一次 `coder` 路由。所有已配置 preset 都会展示，包括不在 `candidates` 中的项；非候选只供查看，不参与自动选择。各 preset 使用同一组角色，由已配置 profile 以及默认 coder、Swarm、Tower 路由组成。每个角色按正常的 preset → 基础配置 → caller 顺序解析实际模型与 Thinking。`main` 不计入，因为自动选择不会修改主模型。

角色权重默认均为 1；权重为 0 的角色仍显示，但不参与平均。角色原始分为 `资源分 + reset 加分 + 路由匹配分 − token 扣分 − 可靠性扣分 − 延迟扣分 − 高峰扣分`。健康原路由的有效贡献是 `max(0, 原始分)`；临时补位的贡献是 `max(0, 替代路由原始分 − 10)`。补位后仍不可用的角色贡献为零，但不从分母中删除。整体分等于这些有效角色分的加权平均，再加一次 preset 顺序加分。评分表还展示补位前原生分、角色覆盖情况和仍不可用的角色。这是路由策略分，不是模型能力百分制。

订阅 provider 的资源分采用有效配额窗口中最低的剩余百分比。通常的保留门槛只会对已确认、仍有正剩余额度的临期订阅放宽；仅凭 reset 时间不会恢复已耗尽的配额。

临期优先使用已声明且至少一天的额度周期；短期限流窗口仍约束可用性，但不能冒充周额度到期。进入临期窗口后，`u = 1 − 距重置时间 / 临期窗口`，加分为 `最大加分 × (exp(指数系数 × u) − 1) / (exp(指数系数) − 1)`；实际窗口取配置提前量和额度周期的较小值。默认情况下，周额度距重置 48 小时约加 18.01 分、24 小时加 66.95 分、12 小时加 117.18 分、1 小时加 191.41 分，在重置前趋近 200 分，不再是原来的最多线性加 2 分。

正的临期加分允许把尚余 12% 的额度用于任务，而不受通常 25% 保留门槛阻挡；但任一适用窗口已耗尽、证据非法或未知、熔断或模型不兼容时仍不可用。缺少周期/reset 证据不加分，多个周期不会叠加临期奖励，按量付费余额也不会获得到期奖励。缓存跨过 reset 边界必须刷新，刷新失败不代表恢复额度。加分只计入实际使用临期额度的角色，再进入整体加权评分；不会为了消耗额度创建空闲任务或模型调用。

官方 DeepSeek 则在 CNY 余额有效且为正、账户可用时获得固定 **100 分的按量账户可用分**，不代表 100% 配额，也不是余额可支撑任务数的估算；人民币金额单独显示。零余额、非法金额、缺失证据和查询失败分别标识；未知费用不会记为零。高峰时段为 `Asia/Shanghai` 时区周一至周五的 `[09:00,12:00)`、`[14:00,18:00)`。`block` 策略会禁用这些路由并显示解除时间；`penalize` 策略允许其他条件正常的路由被调用，并对每个有效 DeepSeek 角色扣除配置的分值；`off` 则不作这两种处理。这是 Hakimi 的路由策略，不表示供应商停服，也不是人民币价格估算。

默认软惩罚为 60 分时，有效 DeepSeek 角色权重占比为 0%、25%、50%、100%，对应整体策略扣分为 0、15、30、60 分。原 DeepSeek 角色已补位成 Kimi 时不再扣此项，实际补位到 DeepSeek 时同样扣分。该惩罚已进入角色原始分，不会在汇总后再扣一次；有效贡献仍以零为下限。余额较多或分数较高都不能绕过真实耗尽、未知证据、能力检查或熔断。

本地运行证据按角色参与可靠性、首 token 延迟和 token 用量扣分；角色样本不足时使用 provider 级证据，并明确标识回退。小样本降低置信度，取消的运行不算可靠性失败。没有样本并不代表可靠性完美或费用为零。查询和 provider 资源摘要按已验证的实际账户去重，不会因为同一账户出现在多个角色中就重复累计余额或历史运行。同账户的 provider 别名不能绕过熔断；模型级凭证或端点覆盖没有对应的账户证据时保持未知。provider 配置或用量开关变化会使缓存和在途证据失效。

账户归属在实际观察到运行开始时捕获，不随之后的 alias 配置变化；运行中身份发生变化时，该次归属证据失效。未观察到开始事件的旧记录仍保留在账本中，但不会套用今天的凭据，也不会在重启后用它们重建账户熔断。因此，“暂无可用的账户历史证据”不表示账本为空。按量统计合并的是当前等价配置别名的本地记录，未知费用和不完整标记仍保留，不是官方账户账单。

原角色不可用时，自动模式优先从允许的 preset 中找健康的同角色路由，再考虑这些 preset 或基础 `agents` 表已使用的兼容模型；不会启用仅出现在被排除 preset 中的 provider。补位必须满足工具和模态要求，图像角色不能换成纯文本或能力未知的模型。账户限制、熔断、禁用模型和时段限制仍然有效。10 分补位扣分用于体现偏离原配置，不是对替代模型能力的评价。

补位只改变本次调用的绑定，不改 preset/agents 表，也不写全局 Memory 覆盖。后续调用重新评估，原路由恢复后自然回归；正在运行的任务不会中途换模型。全局可以选择部分可用的 preset，但实际 Agent、Swarm 或 Tower 派发时，本次角色必须有可用绑定。找不到兼容且有可用资源的替代时，会明确报告无法派发的原因，不会偷偷继续使用不可用路由。普通自动切换仍保留评分余量、冷却和手动选择保护；当前绑定不可用时可以不等冷却直接切换。

手动使用 `/preset` 或 Web Preset 选择器时，会原子地保存 preset 并设置 `manual_lock = true`，手动选择基础路由也一样。相比之下，Agent 调用 `SetSubagentPreset` 只修改 preset，保留原有锁状态：自动模式保持自动，已有手动锁也不会被清除。该锁只保存在本机，并且 daemon 重启后仍然有效；锁定期间，自动评估会在查询 provider 用量前直接返回。

Web Preset 菜单、移动端 Preset 面板和 **设置 > Agent** 始终提供自动选择入口。点击会启用自动切换、清除手动锁，并立即评估整套 preset 及可能的角色补位；已自动时再次点击会重新评估。该主动操作刷新资源证据，跳过普通切换的评分余量和冷却，但不绕过候选资格、资源下限、模型能力、配置的高峰策略或熔断。当前 preset 不在候选列表中不构成隐式锁：自动已启用且未锁定时，普通派发评估也可以将它换成合格候选。只有 `manual_lock` 保护人工选择，高峰时段不会强制某个 preset 名称。结果不变时仍显示原因；环境强制关闭时明确提示，不绕过限制。TUI `/preset auto` 仍只解锁，等待下一次相关调用。

自动激活只修改 `[subagent].preset`，临时角色补位作为本次调用的绑定返回，不覆盖路由表；main/default model 和全局 Thinking 不变。已开启且未锁定的自动模式下，实际派发必须使用验证过的绑定；原路由和补位均不可用时会拒绝该角色，包括无法确认资源证据的情况。手动锁定会停用自动选择和临时补位。新 Agent、可重绑定的 Agent/Swarm resume、新 Swarm item、Tower worker/reviewer 共用此绑定路径；保留 binding 的 profile 跳过该路径。人工激活与自动提交继续串行执行，更晚的人工选择优先。

评分器固定、仅在本机运行且结果可复现：它不会训练模型，不会上传 prompt、路径、错误消息或其他用户内容，也不会在空闲时轮询。交互式 TUI footer 和 Web 聊天 header 会显示 active preset。Hakimi Web 的 Preset 菜单与 **设置 > Agent** 还会展示最近一次结构化原因、触发 profile 和时间、候选评分拆解、配额、冷却、熔断状态以及缺失证据。每次自动切换成功后，触发切换的会话会增加一条带本地化原因的状态标记。程序化客户端可从 [`GET /api/v1/config/subagent-preset/status`](../reference/server-api.md#配置) 读取最近一次进程级全局判断，并订阅该页说明的 evaluated / changed 事件。路由优先级和派生覆盖范围见 [Agent 与 subagent](../customization/agents.md#subagent-模型路由)。

### 已废弃的 `[secondary_model]`

`[secondary_model]` 仍保留显式配置/API schema 的读写能力，以及旧配置文件的兼容性。它不再是第二套产品控制面：加载时会给出废弃警告，`/secondary-model` 和 `/subagent-model` 只显示迁移提示，provider/model 维护会原样保留该节，不会重写或迁移别名。新的配置请使用 `/preset` 和 `[subagent]`。

没有 canonical preset 激活时，`KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1`（或 `KIMI_CODE_EXPERIMENTAL_FLAG=1`）会为 Agent、AgentSwarm 和 Tower worker 启用 best-effort 的 legacy fallback。仅当 legacy `default_model` 或 `model` 仍能解析时才使用它；否则使用调用方模型。Tower reviewer 永远不使用该 fallback。active canonical preset 始终优先；legacy 的 `force`、模型池选择和逐次 `model` 语义不再控制 v2 路由。

以下 legacy 字段仍可通过 `getConfig` / `setConfig` 和 REST/config API 进行 round-trip：

| 字段 | 类型 | 兼容含义 |
| --- | --- | --- |
| `default_model` | `string` | secondary-model flag 开启且没有 preset 时的 best-effort fallback 别名 |
| `models` | `table<string, string>` | 保留的 legacy 模型池数据；不会用于生成 Agent 或 AgentSwarm 工具 schema |
| `force` | `boolean` | 为兼容性保留；不会强制 canonical v2 路由 |
| `model` 和 legacy 模型元数据字段 | 不定 | 为旧配置/API 客户端保留；`model` 可以提供 fallback 别名 |

## `thinking`

`thinking` 设置 Thinking 模式的全局默认行为。

在 Hakimi Web 中，打开 **设置 → Agent → 默认思考强度**，即可为新会话保存 `thinking.effort`。可选档位来自默认模型支持的思考强度列表，包含最高档位。修改强度不会改变 `thinking.enabled`；如需开启或关闭思考，请单独使用 **默认开启思考** 开关。

未保存强度时，选择器显示模型默认值，不会写入偏好。默认模型不可用或不支持调整思考强度时，选择器会禁用。如果默认模型不再支持已保存的强度，该值会标记为不支持，并保持不变，直到你选择一个支持的档位。

如果切换模型后，OpenAI Responses 会话拒绝上一轮携带的加密 Thinking 块，Hakimi 会在当前 step 中移除这个 provider 特有的块并重试一次。可见的 Thinking 摘要、User 消息和工具调用仍会保留在请求中，已存储的历史不会被改写。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | 新会话是否默认开启 Thinking，设为 `false` 可强制关闭 |
| `effort` | `string` | — | Thinking 强度（例如 `low`、`medium`、`high`、`xhigh`、`max`）。非 Kimi provider 在上游协议接受具体 effort 值时不会改写该值；如果上游拒绝，请改成该模型支持的档位。协议仅提供等级或 token budget 时，仍需做格式转换。对于带 `support_efforts` 的 Kimi 模型，若该配置值不在列表中，会回落到模型默认档位；没有该列表的 Kimi 模型会把任意开启值视为布尔 `on` |
| `keep` | `string` | `"all"` | 保留思考透传。在 `kimi` 上以 `thinking.keep` 发送；在 `anthropic`（Claude 以及 Kimi 的 Anthropic 兼容模式）上以 `context_management` 的 `clear_thinking_20251015` 编辑发送（开启 keep 会让 Anthropic 请求走 beta Messages API；关值可禁用 keep 并回到标准端点）。`"all"` 会保留历史轮次的思考内容（`reasoning_content` / Anthropic thinking blocks）；传入关值（`false`/`0`/`no`/`off`/`none`/`null`）可禁用。可被 `KIMI_MODEL_THINKING_KEEP` 覆盖；仅在 Thinking 开启时注入 |

### 已废弃字段

| 字段 | 废弃版本 | 描述 |
| --- | --- | --- |
| `default_thinking` | 0.21.0 | 顶层布尔值，由 `[thinking] enabled` 取代。将 `default_thinking = true` 迁移为 `enabled = true`，`default_thinking = false` 迁移为 `enabled = false`。 |
| `thinking.mode` | 0.21.0 | 可选值 `auto` / `on` / `off`，由 `[thinking] enabled` 取代。`mode = "off"` 改为 `enabled = false`；`mode = "on"` 和 `mode = "auto"` 等价于 `enabled = true`（默认值），可删除该行。 |
| `loop_control.max_retries_per_step` | 0.32.0 | 由 `loop_control.max_attempts_per_step` 取代（该值本来就是含首次尝试的总尝试次数上限）。旧 key 不再生效，启动时会给出警告，请在 `config.toml` 中手动改名。 |
| `loop_control.max_steps_per_run` | 0.32.0 | 由 `loop_control.max_steps_per_turn` 取代。旧 key 不再生效，启动时会给出警告，请在 `config.toml` 中手动改名。 |

## `loop_control`

`loop_control` 控制 Agent 执行循环的步数上限、单步尝试次数上限，以及触发上下文自动压缩的阈值。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `max_steps_per_turn` | `integer` | — | 单轮最大步数；不设或设为 `0` 则无上限 |
| `max_attempts_per_step` | `integer` | `10` | 单步失败后的最大总尝试次数（含首次尝试） |
| `reserved_context_size` | `integer` | — | 预留给模型输出的 token 数；上下文窗口剩余量低于此值时触发自动压缩 |

`max_steps_per_turn` 可被环境变量 `KIMI_LOOP_MAX_STEPS_PER_TURN` 覆盖，`max_attempts_per_step` 可被 `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP` 覆盖，优先级均高于配置文件。旧的 `KIMI_LOOP_MAX_RETRIES_PER_STEP` 已废弃，但在新变量未设置时仍生效（启动时会给出警告）。

重试仅针对瞬时故障——连接错误、超时、HTTP 429 限流和 5xx 服务端错误。账户额度耗尽或余额不足导致的 429 不会重试，会立即失败：在充值之前重试不可能成功。

## `token_counting`

`token_counting` 决定对外上报的上下文 token 计数——即上下文大小显示所基于的值。内部逻辑（自动压缩触发、预算、超限退避）始终同时使用供应商实测与估算，不受本配置影响。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `strategy` | `"measured+estimated" \| "measured" \| "estimated"` | `"measured+estimated"` | `measured+estimated` 上报实时大小——每次请求的供应商实测用量加上未实测尾部的估算——并以最近一次实测总量兜底；`measured` 只上报供应商实测，显示仅在每次请求完成后变化；`estimated` 忽略供应商实测、上报纯估算——适用于不上报用量或用量不可信的供应商 |

`strategy` 可被环境变量 `KIMI_TOKEN_COUNTING_STRATEGY` 覆盖，优先级高于 `config.toml`。

## `background`

`background` 控制后台任务（通过 `Bash` 工具或 `Agent` 工具的 `run_in_background=true` 参数启动）的并发数。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `max_running_tasks` | `integer` | — | 同时运行的最大后台任务数 |
| `keep_alive_on_exit` | `boolean` | `false` | 会话关闭时是否保留仍在运行的后台任务。默认情况下，Hakimi 会在进程退出前请求停止所有后台任务；只有希望任务在会话结束后继续运行时才设为 `true`。在 print 模式（`hakimi -p`）下，本字段仅作为 `print_background_mode` 未设置时的兼容回退：`true` 等价于 `print_background_mode = "drain"` |
| `kill_grace_period_ms` | `integer` | `5000` | 会话关闭、手动停止或任务超时请求正常终止后，等待任务自行结束的宽限时间（毫秒）。超过该时间仍在运行时，Hakimi 会尝试强制停止该任务 |
| `bash_auto_background_on_timeout` | `boolean` | `true` | 前台 `Bash` 命令触及超时时间时，将其转为后台任务而不是直接终止：命令完成时 agent 会收到通知，转入后台的命令受 `bash_task_timeout_s` 默认后台超时约束。设为 `false` 则恢复超时即终止的行为 |
| `bash_task_timeout_s` | `integer` | `600` | 后台 `Bash` 任务在调用未传 `timeout` 时的默认超时（秒）；前台命令超时转后台后也按此值重新计时。`0` 表示无超时——任务一直运行到自行结束或被模型手动停止。显式传入的 `timeout` 不受影响。在 print 模式（`hakimi -p`）下未显式设置时默认为 `0` |
| `print_background_mode` | `"exit" \| "drain" \| "steer"` | `"steer"` | 仅 print 模式（`hakimi -p`）生效，决定 main agent 的 turn 结束后如何处理未返回的后台任务：`"exit"` 立即退出；`"drain"` 退出前等待所有后台任务进入终态（结果不回馈给 main agent）；`"steer"` 不退出，让后台任务完成时像后台 subagent 一样以合成 user 消息 steer main agent 进入新 turn，直到某 turn 结束时无未决后台任务或触及上限。设置后优先级高于 `keep_alive_on_exit` 的 print 回退 |
| `print_wait_ceiling_s` | `integer` | `2147483` | print 模式（`hakimi -p`）下，`print_background_mode` 为 `"drain"` 或 `"steer"` 时，等待/steer 循环的墙钟上限（秒；默认约 24.8 天，近似不设限）。在非 print 模式或 `"exit"` 时无效 |
| `print_max_turns` | `integer` | `100000` | print 模式（`hakimi -p`）且 `print_background_mode = "steer"` 时，允许由后台任务完成触发的新 turn 的最大数量，防止 steer 循环失控（默认值近似不设限） |

`keep_alive_on_exit` 可被环境变量 `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` 覆盖，`max_running_tasks` 可被 `KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS` 覆盖，优先级均高于配置文件。

在 print 模式（`hakimi -p "<prompt>"`）下，只要还有未决的后台任务，Hakimi 在 main agent 的 turn 结束后不会退出：每个任务完成都会以合成 user 消息回馈给 main agent，steer 出新的 turn（默认 `print_background_mode = "steer"`），直到某 turn 结束时没有任何未决任务才退出。该循环受 `print_wait_ceiling_s` 与 `print_max_turns` 约束，默认值都近似不设限。print 模式下后台工作也不会被墙钟超时杀掉：后台 `Bash` 任务默认无超时（`bash_task_timeout_s = 0`），subagent 默认无超时（`[subagent] timeout_ms = 0`），只有模型自己能停止任务。将 `print_background_mode` 设为 `"drain"` 可等待任务结束但不回馈结果，设为 `"exit"` 则在 main agent 结束后立即退出。

## `mcp`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `startup_timeout_ms` | `integer` | `30000`（30 秒） | 所有 MCP server 的全局默认连接（启动 + 工具发现）超时（毫秒），取值范围为 `1`–`2147483647`。`mcp.json` 中单个 server 的 `startupTimeoutMs` 始终优先于本节与环境变量；都未设置时使用默认值 |
| `tool_timeout_ms` | `integer` | `60000`（60 秒） | 所有 MCP server 的全局默认单次工具调用超时（毫秒），取值范围为 `1`–`2147483647`。`mcp.json` 中单个 server 的 `toolTimeoutMs` 始终优先于本节与环境变量；都未设置时使用客户端内置默认值 |

`startup_timeout_ms` 和 `tool_timeout_ms` 可分别被环境变量 `KIMI_MCP_STARTUP_TIMEOUT_MS` 和 `KIMI_MCP_TOOL_TIMEOUT_MS` 覆盖，优先级高于配置文件。MCP server 的完整配置方式见 [MCP](../customization/mcp.md)。

## `identity`

自定义 Agent 的身份标识。不设置时行为完全不变。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `name` | `string` | — | Agent 在系统提示词中的自称（填充 `${product_name}` 变量，你自己的 `SYSTEM.md` 和 agent 文件同样适用） |
| `slug` | `string` | 由 `name` 派生 | 协议字段中使用的机器标识：发给第三方 provider 的 `User-Agent` 产品名，以及连接 MCP 服务器时声明的客户端名。省略时由 `name` 派生：转小写，连续的非字母数字字符折叠为 `-` |

```toml
[identity]
name = "Acme Dev Agent"
slug = "acme-dev"        # 可选
```

两个字段都可以通过 `KIMI_CODE_IDENTITY_NAME` 和 `KIMI_CODE_IDENTITY_SLUG` 环境变量设置，优先级高于 `config.toml`，且不会被写回配置文件——适合不便写配置文件的容器和 CI 场景。

如果名称中不含任何 ASCII 字母或数字（例如纯中文名称），就无法派生出 slug，此时回退为 `agent`；需要特定协议标识请显式填写 `slug`。

身份在启动时解析一次，进程生命周期内保持不变——建立连接时它已宣告给 MCP 服务器和 provider，中途无法更换。修改本节配置在下次启动时对新会话生效；resume 的会话保留录制时的系统提示词，因为其历史轮次本就以原身份自称。同理，已完成的 MCP OAuth 授权保留其授予时的客户端注册；重置该服务器的认证即可在新身份下重新注册。

本节由默认的 `agent-core-v2` 引擎读取。设置 `KIMI_CODE_LEGACY_FLAG=1` 后，旧版 `hakimi` / `hakimi -p` 路径会忽略此配置；`hakimi web` 始终使用 `agent-core-v2`。

## `tools`

`tools` 设置全局工具开关，对所有会话中的每个 Agent 生效，并在 Agent 自身的 `tools` / `disallowedTools` 策略之上再取一次交集。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `array<string>` | — | 全局允许列表：非空时仅列出的工具可用；省略或设为空数组均表示不约束 |
| `disabled` | `array<string>` | — | 全局禁止列表，在 `enabled` 之后应用 |

工具名匹配规则与 Agent 文件中的同名字段一致：内置工具按名称精确匹配（如 `Read`），MCP 工具用 glob 匹配（如 `mcp__github__*`）。有三种写法永远匹配不到任何工具，出现时会给出警告：`mcp__` 模式之外使用通配符（`enabled = ["*"]` 会禁用所有工具，而 `disabled = ["*"]` 什么也禁不掉）；缺少工具段的 `mcp__` 字面量（`mcp__github` —— 匹配整个服务器要用 `mcp__github__*`）；以及任何已注册或内置工具都没有的名字（匹配区分大小写）。

```toml
[tools]
disabled = ["EnterPlanMode", "ExitPlanMode", "mcp__github__*"]
```

::: warning 注意
与 Agent 文件中的 `tools` / `disallowedTools` 一样，本节不仅决定模型能"看到"哪些工具，还会在执行前再次强制检查。[权限规则](#permission)仍是独立的控制层，用于决定哪些操作需要审批。
:::

## `image`

`image` 控制图片发送给模型前的压缩行为，对所有图片入口生效（粘贴图片、`ReadMediaFile` 读图、MCP 工具结果里的图片等）。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `max_edge_px` | `integer` | `2000` | 图片最长边上限（像素）。超过时按比例缩小到该值以内；调大可保留更多细节，代价是更大的请求体积 |
| `read_byte_budget` | `integer` | `262144`（256 KB） | 模型自行读取的图片（`ReadMediaFile` 默认读取）的单图字节预算。会话中模型反复截图、读图时，累计请求体大小由它控制；细节可通过 `region` 参数按原图坐标全保真回读（`region` 与 `full_resolution` 不受此预算限制） |

`max_edge_px` 可被环境变量 `KIMI_IMAGE_MAX_EDGE_PX` 覆盖，`read_byte_budget` 可被 `KIMI_IMAGE_READ_BYTE_BUDGET` 覆盖，优先级均高于配置文件。

## `experimental`

`experimental` 保存实验功能开关的持久化覆盖。以下开关可以分别比较按需工具、精简内置系统提示词和上下文连续性。它们均默认关闭；启用其中一个不会自动启用其他开关，也不会改变执行权限。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `tool_catalog` | `boolean` | `false` | 常用工具立即可用，其他工具先通过简短目录发现，再加载完整定义 |
| `profile_compact_prompt` | `boolean` | `false` | 为明确支持精简版本的内置 profile 使用精简提示词；保留项目指令、Skills、插件内容和模式提醒 |
| `context_continuity` | `boolean` | `false` | 在完整上下文压缩中使用结构化交接和保守的溢出重试策略 |
| `apply_patch` | `boolean` | `false` | 启用可选的[批量文件补丁工具](../reference/tools.md#文件类)，与上述三项策略独立 |

要组合试用三项策略，在现有 `config.toml` 中添加：

```toml
[experimental]
tool_catalog = true
profile_compact_prompt = true
context_continuity = true
```

进行 A/B 对比时，先将三项设为 `false` 作为基线，再分别启用单项，最后测试组合。保持模型、推理强度、任务、权限、可用工具和预算一致。修改提示词设置后，请使用新会话或重新应用 profile：已经渲染的系统提示词不会在每次请求时重写。自定义 Agent 文件和 `SYSTEM.md` 保留自己的提示词渲染方式，除非其 profile 明确提供了精简版本。

对应的环境变量为 `KIMI_CODE_EXPERIMENTAL_TOOL_CATALOG`、`KIMI_CODE_EXPERIMENTAL_PROFILE_COMPACT_PROMPT` 和 `KIMI_CODE_EXPERIMENTAL_CONTEXT_CONTINUITY`，各项环境变量优先于本节配置。受控对比时应取消设置 `KIMI_CODE_EXPERIMENTAL_FLAG`：总开关为真时会启用所有实验，即使单项设为 `false`。开关作用于运行中的引擎，并非仅影响某个会话。这些实验不会自动替用户启用配置。

诊断时可在引擎的 Agent 状态中查看 `toolSelect.diagnostics`（选择模式和工具数量）、`profile.promptDiagnostics`（最近的渲染策略和系统提示词字节数）以及 `fullCompaction.continuityLastRun`（最近的压缩策略、结果、请求次数和缩减数量）。这些是运行时快照，不是持久化的 benchmark 报告；字段不包含提示词原文、工具参数、路径或凭据，也不会加入模型上下文。恢复的提示词或显式覆盖的提示词会单独标记，不会从文本猜测其策略。

具体行为和边界见[按需工具目录](../reference/tools.md#按需工具目录)和[上下文压缩](../guides/sessions.md#上下文压缩)。提示词字节数或工具定义数减少，并不能单独证明费用更低、完成更快或回答更好；选择工具会增加请求，也可能影响提示词缓存复用。

## `services`

`services` 配置网页搜索（`moonshot_search`）和网页抓取（`moonshot_fetch`）两项内置服务。只识别这两个固定 key，其他 key 会被忽略。两项字段相同：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `base_url` | `string` | 否 | 服务 API URL |
| `api_key` | `string` | 否 | API 密钥 |
| `oauth` | `table` | 否 | OAuth 凭据引用，结构同 `providers.*.oauth` |
| `custom_headers` | `table<string, string>` | 否 | 请求时附加的自定义 HTTP 头 |

`base_url` 和 `api_key` 也可由环境变量提供，环境变量优先于配置文件：`KIMI_WEB_SEARCH_BASE_URL` / `KIMI_WEB_SEARCH_API_KEY` 对应 `moonshot_search`，`KIMI_WEB_FETCH_BASE_URL` / `KIMI_WEB_FETCH_API_KEY` 对应 `moonshot_fetch`。`KIMI_WEB_SEARCH_BASE_URL` 和 `KIMI_WEB_FETCH_BASE_URL` 定义的是独立服务端点，因此文件中持久化的 API 密钥、OAuth 引用和自定义 header 都不会发送给它；该端点需要鉴权时，请同时设置对应的环境变量 API 密钥。只设置环境变量 API 密钥时，配置中的端点和自定义 header 保持不变，但两种配置凭据都会被替换。不写配置段、只通过环境变量设置 base URL 和 API 密钥，也可以启用对应服务。

```toml
[services.moonshot_search]
base_url = "https://api.moonshot.cn/v1/search"
api_key = "sk-xxx"

[services.moonshot_fetch]
base_url = "https://api.moonshot.cn/v1/fetch"
api_key = "sk-xxx"
```

## `permission`

`permission` 设置会话启动时自动加载的权限规则，控制 Agent 调用工具时是否需要用户确认。规则用 `[[permission.rules]]` 数组表写出，按顺序匹配，第一条命中即生效。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `decision` | `string` | 是 | 匹配后的处置：`allow`（直接放行）、`deny`（直接拒绝）、`ask`（每次询问） |
| `scope` | `string` | 否 | 规则有效范围：`turn-override`、`session-runtime`、`project`、`user`；默认 `user` |
| `pattern` | `string` | 是 | 匹配模式，格式为 `工具名` 或 `工具名(参数模式)`，如 `Read`、`Bash(rm -rf*)` |
| `reason` | `string` | 否 | 规则说明，仅用于调试和审计 |

内置工具名见[内置工具](../reference/tools.md)。大多数支持规则参数的内置工具会定义自己的匹配对象，例如 `Bash(command-pattern)` 或 `Read(path-pattern)`。`AgentSwarm`、MCP 工具和自定义工具只能按工具名匹配，不支持参数模式。

```toml
[[permission.rules]]
decision = "allow"
pattern = "Read"

[[permission.rules]]
decision = "allow"
pattern = "Grep"

[[permission.rules]]
decision = "deny"
pattern = "Bash(rm -rf*)"

[[permission.rules]]
decision = "ask"
pattern = "Bash"
```

::: tip
MCP server 的声明配置写在 `~/.hakimi/mcp.json` 或项目内 `.kimi-code/mcp.json` 中，不在 `config.toml` 里。交互式配置入口是 `/mcp-config`，详见 [Model Context Protocol](../customization/mcp.md)。
:::

## `tui.toml`

除了 `config.toml`，CLI 还在同一目录下用一份配套的 `tui.toml` 保存终端界面与客户端偏好（`~/.hakimi/tui.toml`，或覆盖后的 `$KIMI_CODE_HOME/tui.toml`）。它在首次运行时以默认值创建，交互式命令 `/config`、`/theme`、`/editor` 会自动写入，通常无需手动编辑。文件格式有误时，CLI 会回退到默认值并给出提示，而不是启动失败。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `theme` | `string` | `auto` | 配色主题：`auto`（跟随终端）、`dark`、`light`，或[自定义主题](../customization/themes.md)的名字 |
| `render_latex` | `boolean` | `true` | 将 Markdown 消息中的 LaTeX 公式（`$…$`、`$$…$$`）渲染为 Unicode 文本；`false` 则保留原始源码 |
| `disable_paste_burst` | `boolean` | `false` | 禁用非 bracketed paste 的粘贴突发兜底；默认开启，避免快速多行粘贴被逐行提交 |
| `cache_expiry_hint` | `boolean` | `true` | resume 长时间未活动的会话、或长时间空闲后发送消息时，若上下文缓存可能已过期则弹出提醒，可选择先压缩或新建会话（仅 v2 引擎） |
| `[editor].command` | `string` | `""` | 编写长输入用的外部编辑器命令；留空则回退到 `$VISUAL` / `$EDITOR` |
| `[notifications].enabled` | `boolean` | `true` | 是否发送桌面通知 |
| `[notifications].notification_condition` | `string` | `unfocused` | 何时通知：`unfocused`（仅终端失去焦点时）或 `always`（总是） |
| `[upgrade].auto_install` | `boolean` | `true` | 是否自动安装新版本 |
| `[status_line].items` | `string[]` | `[]` | 底部状态栏第一行展示哪些内置槽位及其顺序：`mode`、`goal`、`model`、`preset`、`tasks`、`cwd`、`git`、`tips`。缺省保持默认布局；未知 id 跳过并告警 |
| `[status_line].command` | `string` | `""` | 自定义状态栏命令。其 stdout 第一行替换状态栏第一行，stdin 会收到 JSON 快照（model、subagent preset、cwd、git 分支、permission 模式、plan 模式、上下文用量、session id、版本）。运行上限 300ms、每秒最多一次；失败时回退内置布局 |

```toml
# ~/.hakimi/tui.toml
theme = "auto" # "auto" | "dark" | "light" | 自定义主题名
render_latex = true # false 表示消息中的 LaTeX 公式保留原始源码
disable_paste_burst = false # true 表示禁用非 bracketed paste 的粘贴突发兜底
cache_expiry_hint = true # false 表示关闭 resume / 空闲提交时的"缓存已过期"提醒弹窗

[editor]
command = "" # 留空则使用 $VISUAL / $EDITOR

[notifications]
enabled = true
notification_condition = "unfocused" # "unfocused" | "always"

[upgrade]
auto_install = true

# [status_line]
# items = ["mode", "goal", "model", "preset", "tasks", "cwd", "git", "tips"]
# command = "~/.hakimi/statusline.sh"
```

修改在下次启动时生效，或用 `/reload-tui` 立即生效（只重载 `tui.toml`）；`/reload` 会同时重载 `config.toml` 和 `tui.toml`。

## 项目级本地配置

除了 `~/.hakimi` 下的用户级文件，Hakimi 还会读取位于 `<项目根目录>/.kimi-code/local.toml` 的项目级本地配置文件。它保存的是与某一个项目检出相关、通常不应与队友共享的设置。

该文件会在你通过 [`/add-dir`](../reference/slash-commands.md) 添加额外工作目录并选择记入项目时自动创建，通常无需手动编辑。

### `[workspace]`

`[workspace]` 表用于存放项目级的工作区设置：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `additional_dir` | `array<string>` | 否 | 额外工作目录列表，以绝对路径存储。在 `/add-dir` 中确认"记住此目录"时自动写入；启动时读回，使这些目录在该项目的每个会话中都可用 |

```toml
[workspace]
additional_dir = ["/absolute/path/to/shared"]
```

目录以绝对路径存储，与具体机器相关。因此建议把 `.kimi-code/local.toml` 加入项目的 `.gitignore`，避免被提交。

## 下一步

- [平台与模型](./providers.md) — 各供应商类型（Kimi、Claude、OpenAI、Gemini）的接入示例
- [配置覆盖](./overrides.md) — CLI 选项、配置文件、环境变量的优先级规则
- [环境变量](./env-vars.md) — `KIMI_CODE_HOME` 等运行时变量的完整列表
