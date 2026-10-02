# Configuration files

Hakimi writes all long-term preferences — which model to use, which API key to fill in, how many steps an Agent can run per turn — into TOML (a plain-text configuration format with a clear structure) files. Change them once and they take effect on every startup. Agent and runtime settings live in `config.toml`; terminal-UI and client preferences (theme, editor, notifications, auto-update) live in a companion `tui.toml`.

Default location: `~/.hakimi/config.toml`, created automatically on first run.

## Config file location

The CLI reads configuration from `~/.hakimi/config.toml`. To relocate the data directory, override it with the `KIMI_CODE_HOME` environment variable (which takes priority over the default `~/.hakimi`; `HAKIMI_HOME` takes the highest priority):

```sh
export KIMI_CODE_HOME=/path/to/hakimi-home
```

The config file path then becomes `$KIMI_CODE_HOME/config.toml`. Regardless of where the directory lives, the file name is always `config.toml`.

::: tip
TOML field names always use snake_case, for example `default_model` and `max_context_size`. If a key contains `.`, you must quote it — for example `[models."gpt-4.1"]` — otherwise TOML treats `.` as a nested table separator.
:::

## Complete example

The following example covers the most commonly used configuration fields. You can copy it and adjust as needed:

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

## Top-level fields

Fields in the config file fall into two categories: **top-level scalars** that directly control default behavior, and **nested tables** (`providers`, `models`, `thinking`, etc.) that each have their own structure, described individually in the sections below.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `default_model` | `string` | — | Default model alias; must be defined in `models` |
| `default_permission_mode` | `string` | `manual` | Default permission mode for new sessions; one of `manual` (prompt each time), `yolo` (auto-approve tool actions, but the agent may still ask questions), or `auto` (auto-approve tool actions and suppress ordinary conversational questions; explicit protocol-owned workflow decisions may still pause) |
| `default_plan_mode` | `boolean` | `false` | Whether new sessions start in Plan mode (produce a plan before executing) by default |
| `merge_all_available_skills` | `boolean` | `true` | Whether to merge Agent Skills from all available directories |
| `extra_skill_dirs` | `array<string>` | — | Extra skill search directories, layered on top of the default directories |
| `extra_agent_dirs` | `array<string>` | — | Extra custom agent search directories, layered on top of the default directories |
| `builtin_product_skills` | `boolean` | `true` | Whether the built-in skills that document Hakimi itself are offered to the model: `update-config`, `custom-theme`, `mcp-config`, `check-kimi-code-docs`, and `import-from-cc-codex`. Turning them off trims their names and descriptions from the system prompt, at the cost of the guided flows for those tasks. Read by the default `agent-core-v2` engine; ignored when `KIMI_CODE_LEGACY_FLAG=1` selects the legacy engine |
| `telemetry` | `boolean` | `true` | Whether anonymous telemetry is enabled; disabled only when explicitly set to `false` |
| `providers` | `table` | `{}` | API provider table → [`providers`](#providers) |
| `models` | `table` | — | Model alias table → [`models`](#models) |
| `subagent` | `table` | — | Canonical Agent, AgentSwarm, and Tower routes → [`[subagent]`](#subagent) |
| `secondary_model` | `table` | — | Deprecated compatibility fallback and explicit API round-trip data → [`[secondary_model]`](#deprecated-secondary_model) |
| `thinking` | `table` | — | Default parameters for Thinking mode → [`thinking`](#thinking) |
| `loop_control` | `table` | — | Agent loop control parameters → [`loop_control`](#loop-control) |
| `background` | `table` | — | Background task runtime parameters → [`background`](#background) |
| `tools` | `table` | — | Global tool switch → [`tools`](#tools) |
| `image` | `table` | — | Image compression parameters → [`image`](#image) |
| `services` | `table` | — | Built-in external service configuration → [`services`](#services) |
| `permission` | `table` | — | Initial permission rules → [`permission`](#permission) |
| `hooks` | `array<table>` | — | Lifecycle hooks; see [Hooks](../customization/hooks.md) |
| `identity` | `table` | — | Custom agent identity → [`identity`](#identity) |

The following sections cover each of the nested tables in turn: `providers`, `models`, `subagent`, `secondary_model`, `thinking`, `loop_control`, `background`, `tools`, `image`, `services`, and `permission`.

## `providers`

Each entry in the `providers` table defines an API provider, keyed by a unique name. The CLI reads credentials only from here — it does **not** fall back to shell environment variables automatically. Running `export KIMI_API_KEY` in the terminal does not give any provider its key; you must write it explicitly in the config file (see [Config overrides](./overrides.md#provider-credentials)).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` | Yes | Provider type: `kimi`, `anthropic`, `openai`, `openai_responses`, `google-genai`, `vertexai` |
| `api_key` | `string` | No | API key, written in plain text in the config file |
| `base_url` | `string` | No | API base URL |
| `oauth` | `table` | No | OAuth credential reference (`storage` and `key` fields); injected automatically by the login flow — normally no need to write this by hand |
| `env` | `table<string, string>` | No | Fallback source for provider credentials; see below |
| `custom_headers` | `table<string, string>` | No | Custom HTTP headers attached to each request |

**`env` sub-table**: You can write provider-conventional key names (such as `KIMI_API_KEY`) inside `[providers.<name>.env]` as a fallback source for `api_key` / `base_url`. This sub-table is **read only from the config file** and does not modify the shell environment:

```toml
[providers.kimi.env]
KIMI_API_KEY = "sk-xxx"
KIMI_BASE_URL = "https://api.moonshot.ai/v1"
```

Priority: `api_key` field > `env` sub-table key > if both are absent, startup fails with an error.

## `models`

Each entry in the `models` table defines a model alias (the name used in `default_model` or the `-m` flag), keyed by a unique name.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `provider` | `string` | Yes | Name of the provider to use; must be defined in `providers` |
| `model` | `string` | Yes | Model identifier sent to the server when calling the API |
| `max_context_size` | `integer` | Yes | Maximum context length in tokens; must be at least 1 |
| `max_input_size` | `integer` | No | Declared per-request input limit when it sits below the total window (e.g. gpt-5: 400k window, 272k input). Compaction, context-overflow checks, and usage ratios prefer it; completion budgeting keeps the total window. Resolution clamps it to `max_context_size` |
| `max_output_size` | `integer` | No | Per-request output token cap (maps to `max_tokens`). Currently only the `anthropic` provider honors it. When set for a Claude model, this explicit value overrides the built-in server-side maximum |
| `capabilities` | `array<string>` | No | Capability tags to add explicitly: `thinking`, `always_thinking`, `image_in`, `video_in`, `audio_in`, `tool_use`. Unioned with the capabilities auto-detected by the provider — entries can only be added, never removed |
| `support_efforts` | `array<string>` | No | Thinking effort levels the model accepts. For `kimi`, selecting another value at runtime fails; when model resolution carries an unsupported configured or previous value, the session falls back to the target model's `default_effort` and reports that effective value to the UI. A Thinking-capable Kimi model without this field uses boolean `on` / `off`. Other providers pass concrete values unchanged when their protocol has a native effort field; protocols that expose only levels or token budgets perform the required format conversion. Managed and open-platform refreshes may rewrite this field; to pin it manually, set `[models."<alias>".overrides] support_efforts` instead |
| `default_effort` | `string` | No | Default thinking effort for the model. Managed and open-platform refreshes may rewrite this field; to pin it manually, set `[models."<alias>".overrides] default_effort` instead |
| `off_effort` | `string` | No | Effort value sent on the wire to disable thinking (e.g. `none` for xai grok). Only meaningful for models that declare such an encoding (catalog imports set it): turning thinking Off then sends this value instead of omitting the effort field — the only way to actually stop reasoning on models that reason by default |
| `base_url` | `string` | No | Per-model endpoint override (written by catalog imports for gateway models served away from the provider default). Resolution prefers it over the provider's `base_url`; only takes effect together with `protocol` |
| `display_name` | `string` | No | Name shown in the UI; falls back to `model` when unset |
| `reasoning_key` | `string` | No | `openai` provider only. Override the field name used for reasoning content when the gateway returns it under a non-standard name; by default `reasoning_content`, `reasoning_details`, and `reasoning` are auto-detected |
| `adaptive_thinking` | `boolean` | No | `anthropic` provider only. Force adaptive thinking on or off, overriding the version inference based on the model name. Omit to infer automatically (Claude ≥ 4.6 uses adaptive) |

When an alias contains `.`, use a quoted key:

```toml
[models."gpt-4.1"]
provider = "openai"
model = "gpt-4.1"
max_context_size = 1047576
```

### Model overrides

Use `[models."<alias>".overrides]` for user overrides that must survive provider-model refreshes. Runtime consumers read the effective value: the override when present, otherwise the top-level field.

```toml
[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144

[models."kimi-code/kimi-for-coding".overrides]
max_context_size = 131072
display_name = "Kimi for Coding (custom)"
```

`[models."<alias>".overrides]` accepts ordinary model fields such as `max_context_size`, `max_input_size`, `max_output_size`, `capabilities`, `display_name`, `reasoning_key`, `adaptive_thinking`, `support_efforts`, `default_effort`, and `off_effort`. It does not accept identity / routing fields: `provider`, `model`, `protocol`, `beta_api`, and `base_url`.

You can also switch models temporarily without touching the config file — by setting `KIMI_MODEL_*` environment variables, the CLI synthesizes a temporary provider in memory that does not persist after restart. See [Define a model from environment variables](./env-vars.md#define-a-model-from-environment-variables-kimi-model).

## `[subagent]`

The `[subagent]` section is the canonical model control surface for Agent, AgentSwarm, and Tower routes. Each route may set a model alias with `model` and a Thinking level with `thinking_effort`; aliases must exist in [`[models]`](#models).

### Canonical subagent routes

Set an active preset and define route tables like this:

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

The route keys have fixed meanings:

- `main`: the main-agent model and Thinking setting applied when a preset is activated. The TUI's `/preset` command keeps the global `default_model` and `thinking` values in sync with this route; Hakimi Web's chat-header Preset button applies it to the active session or current draft.
- `explore`, `plan`, `coder`, and other profile names: Agent routes for the selected subagent profile.
- `swarm`: the default AgentSwarm route; a swarm's selected profile can still contribute its profile route.
- `tower_worker`: the model for Tower worker tasks.
- `tower_reviewer`: the model for Tower reviewer tasks. Worker and reviewer routes are independent.

When a preset is active, route resolution follows these priorities. Agent uses `presets.<active>.<profile>` → `agents.<profile>` → the caller's model and Thinking level. AgentSwarm uses `presets.<active>.swarm` → `presets.<active>.<profile>` → `agents.swarm` → `agents.<profile>` → the caller. Tower uses the matching `presets.<active>.tower_worker` or `presets.<active>.tower_reviewer` route → the matching `agents` route → the caller. With no active preset, the `agents` route is considered before the caller. A configured canonical alias that cannot be resolved is a configuration error; inactive preset routes do not block startup.

Agent and AgentSwarm do not accept a per-spawn `model` parameter. Choose the model through these canonical routes instead; the tool call still selects the profile with `subagent_type` where applicable. The route is applied on fresh spawns and on resume, so changing a normal profile route affects later resumes while a preserved binding remains unchanged.

### Timeout

`timeout_ms` sets the maximum wall-clock time for one subagent task (`7200000` by default, or 2 hours). Set it to `0` for no timeout. `KIMI_SUBAGENT_TIMEOUT_MS` takes priority over the config value; in print mode (`hakimi -p`) the default is `0` unless explicitly set. Values above `2147483647` (about 24.8 days) are clamped by the runtime.

### Automatic preset switching

The engine can evaluate configured presets immediately before a relevant subagent binding and choose the highest-scoring healthy candidate. `candidates` remains the user's local priority order, but it is no longer a strict fallback chain: position contributes a priority bonus, so a lower-listed preset can overtake when its quota, local reliability, first-token latency, token usage, or route/model fit is materially better. The behavior is experimental and off by default: enable the `auto_subagent_preset` experimental flag ([environment variables](../configuration/env-vars.md#runtime-switches)) and set `auto_preset.enabled` in this section. In Hakimi Web, **Settings > Agent > Automatic preset switching** controls both required settings and lets you edit the local order; it does not poll or change the preset while the session is idle. The switch shows the effective runtime state, so an environment or master-flag override can keep it different from the saved value.

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

The `auto_preset` fields are:

- `enabled`: turn the automatic evaluation on; `false` by default. The experimental flag must also be enabled for the evaluation to run.
- `manual_lock`: preserve the current manual choice and skip automatic evaluation; `false` by default. Manual preset activation sets it to `true`. Web automatic selection clears it and evaluates immediately; TUI `/preset auto` clears only the lock.
- `candidates`: the preset names to consider, ordered from most to least preferred. Position supplies a linear priority bonus rather than an absolute ordering. When omitted, every configured preset is a candidate in file order. An explicit empty array leaves no automatic dispatch target: it preserves the stored preset but rejects new automatic bindings rather than using a preset outside the candidates. To keep dispatching with a fixed preset, use `manual_lock` or disable automatic selection.
- `role_weights`: optional per-role weights, for example `{ coder = 2, reviewer = 2 }`. Unspecified roles weigh 1; values must be finite and non-negative. Zero-weight roles remain visible. A preset with zero total role weight cannot be selected.
- `deepseek_peak_policy`: optional `block`, `penalize`, or `off`. `block` makes official DeepSeek unavailable during peak windows; `penalize` allows otherwise healthy DeepSeek routes but deducts a weighted routing score; `off` ignores the peak window. Explicitly choosing `penalize` permits peak-time paid calls.
- `deepseek_peak_penalty`: per-role peak penalty in `penalize` mode (`60` points by default). This is a finite non-negative policy score, not a currency amount; the whole-preset contribution is weighted by the effective DeepSeek role share.
- `deepseek_avoid_peak_hours`: legacy fallback, default `true`, used only when `deepseek_peak_policy` is absent: true means `block`, false means `off`. Existing hard bans therefore stay hard bans until explicitly changed. Balance evidence still requires `deepseek_usage`; disabling its queries does not imply a funded account.
- `quota_floor_percent`: the ordinary remaining-subscription reserve floor (`25`). A valid expiring allowance with a positive exponential priority bonus can use the remaining quota below this reserve, but never bypasses an exhausted quota window, unknown resource evidence, capability checks, or circuit breakers.
- `reset_priority_window_ms`: the advance window for exponential subscription-reset priority (`259200000`, 72 hours), capped by the allowance's own declared cycle. Only cycles of at least one day qualify; a five-hour rate limit is not a weekly expiry.
- `reset_priority_exponent`: the exponential curve coefficient (`3`); larger values concentrate more of the increase close to reset.
- `reset_priority_max_bonus`: the maximum per-role expiry-priority bonus (`200` points, not a quota percentage). Set it to `0` to disable both the bonus and its reserve-floor exception.
- `switch_margin_percent`: how far the best candidate's score must lead a healthy current preset before a normal switch (`10`).
- `local_usage_window_ms`: how far back local run evidence is counted (`3600000`, one hour).
- `local_usage_weight_percent`: the maximum normalized local token-usage penalty (`10`).
- `priority_weight_percent`: the maximum priority bonus (`20`). With multiple candidates it decreases linearly from the first candidate to zero at the last; a single candidate receives the full bonus.
- `reliability_weight_percent`: the maximum penalty from the confidence-adjusted local failure rate (`20`).
- `latency_weight_percent`: the maximum penalty from confidence-adjusted, normalized time to first token (`10`).
- `switch_cooldown_ms`: process-local cooldown after a successful automatic switch (`600000`, ten minutes). It blocks ordinary score-based switching, not escape from an unhealthy current preset.
- `circuit_breaker_failure_threshold`: consecutive failed local runs that open a provider circuit (`3`). Cancelled runs do not count, and a later success closes the circuit early.
- `circuit_breaker_cooldown_ms`: how long an open circuit remains unavailable after the latest failure (`900000`, fifteen minutes).
- `refresh_interval_ms`: how long provider quota answers are cached between spawns (`300000`, five minutes); a finished subagent run invalidates the cache immediately.
- `query_timeout_ms`: per-provider quota query timeout (`5000`).
- `allow_extra_usage`: when `true`, a positive Kimi Extra Usage wallet balance covers a depleted plan quota: the provider's effective remaining percent is the larger of the lowest plan-window remaining and the wallet's remaining share. Extra Usage is never spent automatically; the default `false` never counts the wallet. The wallet itself has no subscription-expiry bonus. If the raw subscription is exhausted and only the opted-in wallet makes the route usable, no expiry bonus is awarded; a still-consumable subscription can retain its own valid expiry priority.

Scoring covers the whole preset, not just the next `coder` route. Every configured preset is shown, including presets excluded from `candidates`; excluded presets are informational and cannot win automatic selection. All presets use the same role set, built from the configured profiles plus the default coder, Swarm, and Tower routes. Each role resolves its actual model and Thinking through the normal preset → base → caller rules. The `main` entry is excluded because automatic selection never changes the main model.

Role weights default to 1. A zero-weight role remains visible but does not enter the average. A role's raw score is `resource score + reset bonus + route/model-fit bonus − token penalty − reliability penalty − latency penalty − peak penalty`. A healthy original route contributes `max(0, raw score)`; a temporary replacement contributes `max(0, replacement raw score − 10)`. A role still unavailable after replacement contributes zero without being removed from the denominator. The overall score is the weighted mean of those effective role scores plus the preset's priority bonus, added once. The table also shows the native score before replacements, role coverage, and which roles remain unavailable. These are routing-policy points, not a model-quality percentage.

For subscription providers, the resource score is the lowest remaining percentage across valid quota windows. The ordinary reserve floor can be relaxed only for verified, still-positive expiring subscription quota. Reset timing alone never restores an exhausted window.

Expiry priority uses a declared allowance cycle of at least one day; short rate-limit windows remain availability constraints but cannot masquerade as weekly expiry. Within the advance window, `u = 1 − time_to_reset / horizon` and the bonus is `max_bonus × (exp(exponent × u) − 1) / (exp(exponent) − 1)`. The effective horizon is the smaller of the configured advance window and the declared cycle. With defaults, a weekly allowance gets approximately +18.01 points at 48 hours, +66.95 at 24 hours, +117.18 at 12 hours, and +191.41 at one hour; the bonus approaches +200 immediately before reset, rather than the former linear +2 maximum.

A positive expiry bonus can make a remaining 12% usable below the normal 25% reserve, but any exhausted applicable window, invalid/unknown evidence, circuit breaker, or incompatible model still blocks the route. Missing cycle/reset metadata earns no boost. Multiple allowance windows do not stack expiry bonuses, and pay-as-you-go balances do not acquire an expiry bonus. Quota caches crossing a reset boundary must be refreshed; a failed refresh does not imply new quota. The bonus is attributed to the actual role using the expiring allowance and then enters the normal weighted preset score. No idle tasks or model calls are created just to spend unused quota.

For official DeepSeek, a valid positive CNY balance and an available account give a fixed **100 funded-account points**, not 100% quota and not an estimate of how many tasks the balance can fund. The amount is displayed separately. Zero, invalid, missing, or failed balance evidence is distinguished; unknown costs remain unknown rather than becoming zero. Peak windows are Monday–Friday `[09:00, 12:00)` and `[14:00, 18:00)` in `Asia/Shanghai`. The `block` policy makes those routes unavailable and shows when the restriction ends. The `penalize` policy keeps otherwise healthy routes callable and subtracts the configured points from each effective DeepSeek role; `off` does neither. This is Hakimi's routing policy, not an assertion that the provider is offline or a monetary price estimate.

With the default 60-point soft penalty, effective DeepSeek role-weight shares of 0%, 25%, 50%, and 100% contribute whole-preset deductions of 0, 15, 30, and 60 points. A DeepSeek role replaced by Kimi no longer attracts this penalty, while a temporary replacement that actually uses DeepSeek does. The deduction is already included in each role's raw score and is not applied again after aggregation; the existing zero clamp still bounds effective contributions. Neither high balance nor a high score bypasses genuine exhaustion, unknown evidence, capability checks, or circuit breakers.

Local evidence contributes reliability, first-token latency, and token-use penalties per role, with provider-level fallback identified when role samples are sparse. Small samples reduce confidence; cancelled runs do not count as reliability failures. A missing sample is not proof of perfect reliability or zero cost. Queries and provider resource summaries are deduplicated by verified effective account, and repeated role rows do not multiply the same account balance or historical run. Provider aliases sharing an account cannot bypass its circuit breaker. Model-level credential or endpoint overrides without matching account evidence remain unknown; provider configuration or usage-gate changes invalidate cached and in-flight evidence.

Account attribution is captured when a live run starts and does not follow later alias changes. An identity change during a run makes that run's attribution unusable. Older records without a witnessed start remain in the ledger but are not reassigned to today's credentials or used to reconstruct account circuit breakers after restart; “no usable account history” does not mean the ledger is empty. Metered usage groups the local records for currently equivalent configured provider aliases, retaining unknown/partial costs. It is not an official account bill.

If an original role is unavailable, automatic mode first looks for a healthy same-role route in the allowed presets, then a compatible model already used by those presets or the base `agents` table. It does not enable a provider found only in an excluded preset. Replacements must satisfy tool and modality requirements; an image role cannot fall back to a text-only or unknown-capability model. Account limits, circuit breakers, prohibited models, and time restrictions still apply. The 10-point replacement penalty makes the deviation visible; it is not a claim about the replacement model's ability.

A replacement changes only the binding for that invocation, not the preset/agents tables or a global Memory override. Later invocations reevaluate and use the original route once it recovers; running tasks are not switched mid-run. Partially available presets can be selected globally, but an actual Agent, Swarm, or Tower invocation must have a usable binding for its own role. With no compatible funded alternative, that invocation reports why it cannot be dispatched instead of silently running the unavailable route. Normal switching retains the score margin, cooldown, and manual-choice protections; an unavailable current binding can escape without waiting for the cooldown.

A manual `/preset` or Web Preset selection atomically saves the preset and sets `manual_lock = true`, including a manual choice of base routing. In contrast, an agent's `SetSubagentPreset` call changes only the preset and preserves the existing lock state: automatic mode stays automatic, and an existing manual lock is not cleared. The lock is local and survives daemon restarts; automatic evaluation returns before querying provider usage while it is set.

The Web Preset menu, mobile Preset panel, and **Settings > Agent** always offer automatic selection. Clicking it enables automatic switching, clears the lock, and immediately evaluates whole presets and possible role replacements; clicking it again while automatic mode is active runs a fresh evaluation. This explicit action refreshes resource evidence and bypasses normal switch margin and cooldown, but not candidate membership, resource limits, model capabilities, the configured peak policy, or circuit breakers. An out-of-candidate current preset is not an implicit lock: when automatic mode is enabled and unlocked, ordinary dispatch evaluation can replace it with an eligible candidate. Only `manual_lock` protects a manual choice; a peak window never forces a preset name. An unchanged result still displays its reason. Environment-forced disabling is reported rather than bypassed. TUI `/preset auto` still only clears the lock and waits for the next relevant invocation.

Automatic preset activation changes only `[subagent].preset`; temporary role replacements are returned as per-invocation bindings, never written over route tables. Main/default model and global Thinking remain unchanged. In enabled, unlocked automatic mode, actual dispatch consumes the validated binding and rejects a role with no usable original or replacement, including when resource evidence is unavailable. Manual locking disables automatic selection and temporary replacement. Fresh Agent, rebindable Agent/Swarm resumes, new Swarm items, and Tower workers/reviewers share this binding path; profiles that preserve their binding skip it. Manual activation and automatic commits remain serialized so a newer human choice wins.

The scorer is fixed, local, and reproducible: it does not train a model, upload prompts, paths, error messages, or other user content, or run as an idle poll. The interactive TUI footer and Web chat header show the active preset. Hakimi Web also presents the latest structured reason, triggering profile and time, candidate score breakdowns, quota, cooldown, circuit-breaker state, and missing evidence under the Preset menu and **Settings > Agent**. A successful automatic switch adds a localized reason marker to the triggering session. Programmatic clients can read the latest process-global decision from [`GET /api/v1/config/subagent-preset/status`](../reference/server-api.md#config) and follow the evaluated and changed events described there. See [Agents and sub-agents](../customization/agents.md#subagent-model-routing) for route precedence and spawn coverage.

### Deprecated `[secondary_model]`

`[secondary_model]` is retained for explicit config/API schema reads and writes and for compatibility with older files. It is not a second product control surface: loading it emits a deprecation warning, `/secondary-model` and `/subagent-model` only show a migration notice, and provider/model maintenance preserves the section exactly instead of rewriting or migrating aliases. Use `/preset` and `[subagent]` for new configuration.

When no canonical preset is active, `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1` (or `KIMI_CODE_EXPERIMENTAL_FLAG=1`) enables a best-effort legacy fallback for Agent, AgentSwarm, and Tower workers. The legacy `default_model` or `model` value is used only if its alias still resolves; otherwise the caller's model is used. Tower reviewers never use this fallback. An active canonical preset always takes precedence, and the legacy `force`, pool choice, and per-spawn `model` semantics no longer control v2 routing.

The legacy fields remain accepted for round-tripping through `getConfig` / `setConfig` and the REST/config APIs:

| Field | Type | Compatibility meaning |
| --- | --- | --- |
| `default_model` | `string` | Best-effort fallback alias when the secondary-model flag is enabled and no preset is active |
| `models` | `table<string, string>` | Preserved legacy pool data; it is not used to build Agent or AgentSwarm tool schemas |
| `force` | `boolean` | Preserved for compatibility; it does not force a canonical v2 route |
| `model` and legacy model metadata fields | varies | Preserved for older config/API clients; `model` can supply the fallback alias |

## `thinking`

`thinking` sets the global default behavior for Thinking mode.

In Hakimi Web, open **Settings → Agent → Default thinking effort** to save `thinking.effort` for new sessions. The choices come from the default model's supported effort levels, including its highest tier. Changing effort does not change `thinking.enabled`; use **Thinking by default** to turn it on or off separately.

When no effort is saved, the selector shows the model default without writing a preference. If the default model is unavailable or does not support adjustable effort, the selector is disabled. A saved effort that the default model no longer supports is marked as unsupported and kept unchanged until you select a supported level.

When a model switch makes an OpenAI Responses session reject the previous turn's encrypted Thinking block, Hakimi rebuilds the current step without that provider-specific block and retries once. Visible Thinking summaries, user messages, and tool calls stay in the outgoing request, and the stored history is not rewritten.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Whether Thinking is enabled by default for new sessions; set to `false` to force Thinking off |
| `effort` | `string` | — | Thinking effort level (for example `low`, `medium`, `high`, `xhigh`, `max`). Non-Kimi providers do not remap concrete effort values when the upstream protocol accepts them; if the provider rejects the value, choose one that the model supports. Protocols that expose only levels or token budgets still require format conversion. Kimi models with `support_efforts` fall back to their model default when this configured value is not listed; Kimi models without that list treat every enabled value as boolean `on` |
| `keep` | `string` | `"all"` | Preserved Thinking passthrough. On `kimi` it is sent as `thinking.keep`; on `anthropic` (Claude and Kimi's Anthropic-compatible mode) it is sent as a `context_management` `clear_thinking_20251015` edit (enabling keep routes Anthropic requests to the beta Messages API; an off-value disables keep and returns to the standard endpoint). `"all"` preserves prior turns' reasoning (`reasoning_content` / Anthropic thinking blocks); set to an off-value (`false`/`0`/`no`/`off`/`none`/`null`) to disable. Overridden by `KIMI_MODEL_THINKING_KEEP`; only injected while Thinking is on |

### Deprecated fields

| Field | Deprecated in | Description |
| --- | --- | --- |
| `default_thinking` | 0.21.0 | Top-level boolean, replaced by `[thinking] enabled`. Migrate `default_thinking = true` to `enabled = true`, and `default_thinking = false` to `enabled = false`. |
| `thinking.mode` | 0.21.0 | One of `auto` / `on` / `off`, replaced by `[thinking] enabled`. `mode = "off"` becomes `enabled = false`; `mode = "on"` and `mode = "auto"` are equivalent to `enabled = true` (the default) and can be removed. |
| `loop_control.max_retries_per_step` | 0.32.0 | Replaced by `loop_control.max_attempts_per_step` (the value was always a total-attempt limit, including the first try). The old key is ignored and reports a warning on startup; rename it in `config.toml`. |
| `loop_control.max_steps_per_run` | 0.32.0 | Replaced by `loop_control.max_steps_per_turn`. The old key is ignored and reports a warning on startup; rename it in `config.toml`. |

## `loop_control`

`loop_control` governs the step count limit, the per-step attempt limit, the threshold that triggers automatic context compaction, and the request limit for each compaction operation in the Agent execution loop.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `max_steps_per_turn` | `integer` | — | Maximum steps per turn; unset or `0` means unlimited |
| `max_attempts_per_step` | `integer` | `10` | Maximum total attempts for a failing step, including the initial attempt |
| `reserved_context_size` | `integer` | — | Number of tokens reserved for model output; automatic compaction is triggered when the remaining context window falls below this value |
| `compaction_max_attempts` | `integer` | `5` | Maximum total model requests for one compaction operation, including transient retries and requests after history shrinking or context-overflow recovery; must be at least `1` |

`max_steps_per_turn` can be overridden by the `KIMI_LOOP_MAX_STEPS_PER_TURN` environment variable, and `max_attempts_per_step` by `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP`; both take higher priority than the config file. The former `KIMI_LOOP_MAX_RETRIES_PER_STEP` variable is deprecated but still honored (with a startup warning) when the new one is unset.

Retries only apply to transient failures — connection errors, timeouts, HTTP 429 rate limits, and 5xx server errors. A 429 caused by an exhausted quota or insufficient account balance is not retried and fails immediately, since it cannot succeed until the account is recharged.

## `token_counting`

`token_counting` selects which context token count is reported externally — the value behind the context-size display. Internal logic (automatic compaction triggers, budgets, and overflow backoff) always uses both provider-reported usage and estimates, regardless of this setting.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `strategy` | `"measured+estimated" \| "measured" \| "estimated"` | `"measured+estimated"` | `measured+estimated` reports the live size — the provider-reported usage of each exchange plus an estimate of the not-yet-measured tail — floored by the last measured total; `measured` reports provider usage alone, so the display only moves when an exchange completes; `estimated` reports a pure estimate with provider usage ignored — the fallback for providers that do not report usage or report it unreliably |

`strategy` can be overridden by the `KIMI_TOKEN_COUNTING_STRATEGY` environment variable, which takes higher priority than `config.toml`.

## `background`

`background` controls the concurrency behavior of background tasks (launched via the `Bash` tool or the `Agent` tool's `run_in_background=true` parameter).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `max_running_tasks` | `integer` | — | Maximum number of background tasks running concurrently |
| `keep_alive_on_exit` | `boolean` | `false` | Whether to keep still-running background tasks when the session closes. By default, Hakimi requests that all background tasks stop before the process exits; set this to `true` only when you want tasks to outlive the session. In print mode (`hakimi -p`), this is only a legacy fallback used when `print_background_mode` is unset: `true` is equivalent to `print_background_mode = "drain"` |
| `kill_grace_period_ms` | `integer` | `5000` | Grace period in milliseconds after session close, a manual stop, or a task timeout requests graceful termination. If a task is still running after this period, Hakimi attempts to force-stop it |
| `bash_auto_background_on_timeout` | `boolean` | `true` | When a foreground `Bash` command hits its timeout, move it to a background task instead of killing it — the agent is notified when it completes, and the backgrounded command is bounded by the `bash_task_timeout_s` default background timeout. Set to `false` to kill timed-out foreground commands instead |
| `bash_task_timeout_s` | `integer` | `600` | Default timeout (seconds) for background `Bash` tasks when the call omits `timeout`; also used to re-arm foreground commands moved to the background on timeout. `0` means no timeout — the task runs until it exits or the model stops it. Explicit per-call `timeout` values are unaffected. In print mode (`hakimi -p`) the default is `0` unless explicitly set |
| `print_background_mode` | `"exit" \| "drain" \| "steer"` | `"steer"` | Print mode (`hakimi -p`) only. Governs how pending background tasks are handled once the main agent's turn ends: `"exit"` exits immediately; `"drain"` waits for every background task to reach a terminal state before exiting (results are not fed back to the main agent); `"steer"` stays alive so a completing background task — like a background subagent — injects a synthetic user message that steers the main agent into a new turn, looping until a turn ends with no pending background tasks or a limit is hit. Takes precedence over the `keep_alive_on_exit` print fallback |
| `print_wait_ceiling_s` | `integer` | `2147483` | In print mode (`hakimi -p`), the wall-clock ceiling (seconds) for the wait/steer loop when `print_background_mode` is `"drain"` or `"steer"` (the default is ~24.8 days — effectively unbounded). Has no effect outside print mode or when it is `"exit"` |
| `print_max_turns` | `integer` | `100000` | In print mode (`hakimi -p`) with `print_background_mode = "steer"`, the maximum number of new turns that may be triggered by background-task completions, to keep the steering loop bounded (the default is effectively unbounded) |

`keep_alive_on_exit` can be overridden by the `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` environment variable, `max_running_tasks` by `KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS`, `bash_task_timeout_s` by `KIMI_CODE_BACKGROUND_BASH_TASK_TIMEOUT_S`, and `print_background_mode`, `print_wait_ceiling_s`, and `print_max_turns` by `KIMI_CODE_BACKGROUND_PRINT_BACKGROUND_MODE`, `KIMI_CODE_BACKGROUND_PRINT_WAIT_CEILING_S`, and `KIMI_CODE_BACKGROUND_PRINT_MAX_TURNS`; all take higher priority than `config.toml`.

In print mode (`hakimi -p "<prompt>"`), Hakimi stays alive after the main agent's turn as long as background tasks are still pending: each completion is fed back to the main agent as a synthetic user message, steering it into a new turn (`print_background_mode = "steer"` by default), and the run exits once a turn ends with nothing pending. The loop is bounded by `print_wait_ceiling_s` and `print_max_turns`, both effectively unbounded by default. Background work is never killed by a wall-clock cap in print mode either: background `Bash` tasks default to no timeout (`bash_task_timeout_s = 0`), and subagents run without a timeout (`[subagent] timeout_ms = 0`), so only the model itself stops a task. Set `print_background_mode` to `"drain"` to wait for tasks without feeding results back, or `"exit"` to end the run as soon as the main agent finishes.

## `mcp`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `startup_timeout_ms` | `integer` | `30000` (30 seconds) | Global default connection (startup + tool discovery) timeout in milliseconds for all MCP servers. Accepts `1`–`2147483647`. A per-server `startupTimeoutMs` in `mcp.json` always wins over this section and the environment variable; when neither is set, the default applies |
| `tool_timeout_ms` | `integer` | `60000` (60 seconds) | Global default single tool-call timeout in milliseconds for all MCP servers. Accepts `1`–`2147483647`. A per-server `toolTimeoutMs` in `mcp.json` always wins over this section and the environment variable; when neither is set, the client built-in default applies |

`startup_timeout_ms` and `tool_timeout_ms` can be overridden by the `KIMI_MCP_STARTUP_TIMEOUT_MS` and `KIMI_MCP_TOOL_TIMEOUT_MS` environment variables respectively, which take higher priority than `config.toml`. See [MCP](../customization/mcp.md) for the full MCP server configuration.

## `identity`

Customizes how the agent identifies itself. Leave it unset and nothing changes.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | — | Display name the agent calls itself in the system prompt (fills the `${product_name}` slot, including in your own `SYSTEM.md` and agent files) |
| `slug` | `string` | derived from `name` | Machine identifier used in protocol fields: the `User-Agent` product token sent to third-party providers, and the client name announced to MCP servers. Derived from `name` when omitted: lowercased, with every run of non-alphanumeric characters folded to `-` |

```toml
[identity]
name = "Acme Dev Agent"
slug = "acme-dev"        # optional
```

Both fields can be set through the `KIMI_CODE_IDENTITY_NAME` and `KIMI_CODE_IDENTITY_SLUG` environment variables, which take higher priority than `config.toml` and are never written back to it — convenient for containers and CI, where writing a config file is awkward.

A name that contains no ASCII letters or digits (for example a purely Chinese name) leaves nothing to derive a slug from and falls back to `agent`; write `slug` explicitly if you need a specific protocol token.

The identity is resolved once at startup and holds for the life of the process — it is announced to MCP servers and providers when connections are made, so it cannot change midway. Edits to this section take effect on the next start, for new sessions: a resumed session keeps the system prompt it was recorded with, since its past turns already speak under that identity. Likewise, an MCP OAuth authorization keeps the client registration it was granted under; reset that server's authentication to register under the new identity.

This section is read by the default `agent-core-v2` engine. It is ignored by the legacy `hakimi` / `hakimi -p` path selected with `KIMI_CODE_LEGACY_FLAG=1`; `hakimi web` always uses `agent-core-v2`.

## `tools`

`tools` is the global tool switch: it applies to every agent in all sessions and intersects with each agent's own `tools` / `disallowedTools` policy.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `array<string>` | — | Global allowlist: when non-empty, only the listed tools are available; omitting the field or setting an empty array imposes no constraint |
| `disabled` | `array<string>` | — | Global denylist, applied after `enabled` |

Name matching follows the same rules as the same-named fields in an agent file: built-in tools match by exact name (such as `Read`), and MCP tools match with globs (such as `mcp__github__*`). Three entry shapes never match anything and are reported with a warning: a wildcard outside an `mcp__` pattern (`enabled = ["*"]` disables every tool, `disabled = ["*"]` disables none), an `mcp__` literal missing the tool segment (`mcp__github` — use `mcp__github__*` for a whole server), and a name no registered or built-in tool has (matching is case-sensitive).

```toml
[tools]
disabled = ["EnterPlanMode", "ExitPlanMode", "mcp__github__*"]
```

::: warning Note
Like the `tools` / `disallowedTools` fields of an agent file, this section shapes the tools shown to the model and is enforced again before execution. [Permission rules](#permission) remain a separate control for operations that require approval.
:::

## `image`

`image` controls how images are compressed before being sent to the model, across every ingestion point (pasted images, `ReadMediaFile` reads, images in MCP tool results, and so on).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `max_edge_px` | `integer` | `2000` | Longest-edge ceiling in pixels. Larger images are scaled down proportionally to fit; raising it preserves more detail at the cost of larger request bodies |
| `read_byte_budget` | `integer` | `262144` (256 KB) | Per-image byte budget for images the model reads for itself (`ReadMediaFile` default reads). It bounds the accumulated request-body size when the model keeps screenshotting and reading images; fine detail stays reachable through the `region` parameter, which reads a crop back at full fidelity (`region` and `full_resolution` are not subject to this budget) |

`max_edge_px` can be overridden by the `KIMI_IMAGE_MAX_EDGE_PX` environment variable and `read_byte_budget` by `KIMI_IMAGE_READ_BYTE_BUDGET`; both take higher priority than `config.toml`.

## `experimental`

`experimental` stores persistent overrides for experimental-feature flags. The following switches let you compare on-demand tools, shorter built-in system prompts, and context continuity independently. They are all off by default; enabling one does not enable the others or change execution permissions.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `tool_catalog` | `boolean` | `false` | Keep common tools immediately available and discover other tools through a brief catalog before loading their full definitions |
| `profile_compact_prompt` | `boolean` | `false` | Use the compact prompt renderer for opted-in built-in profiles; keep project instructions, Skills, plugin contributions, and mode reminders |
| `context_continuity` | `boolean` | `false` | Use a structured handoff and conservative overflow retries in full context compression |
| `apply_patch` | `boolean` | `false` | Enable the optional [batch file patch tool](../reference/tools.md#file-tools); independent of the three policies above |

To try the three policies together, add these values to your existing `config.toml`:

```toml
[experimental]
tool_catalog = true
profile_compact_prompt = true
context_continuity = true
```

For an A/B comparison, set all three to `false` for the baseline, then enable one at a time, followed by the combination. Keep the model, effort, task, permissions, available tools, and budgets the same. Use new sessions or reapply the profile after changing prompt settings: an already-rendered system prompt is not rewritten on each request. Custom agent files and `SYSTEM.md` keep their own prompt rendering unless their profile explicitly provides a compact renderer.

The corresponding environment variables are `KIMI_CODE_EXPERIMENTAL_TOOL_CATALOG`, `KIMI_CODE_EXPERIMENTAL_PROFILE_COMPACT_PROMPT`, and `KIMI_CODE_EXPERIMENTAL_CONTEXT_CONTINUITY`. Per-feature environment values override this section. Unset `KIMI_CODE_EXPERIMENTAL_FLAG` for controlled comparisons: a truthy master flag enables every experiment, even when an individual switch is `false`. Flags apply to the running engine, not just one conversation. No configuration is automatically enabled by these experiments.

For diagnostics, the engine's agent state exposes `toolSelect.diagnostics` (selection mode and tool counts), `profile.promptDiagnostics` (last render policy and system-prompt byte count), and `fullCompaction.continuityLastRun` (last compression policy, outcome, request count, and reduction counts). These are runtime snapshots, not a persistent benchmark report. The fields contain no prompt text, tool arguments, paths, or credentials and are not added to the model's context. A restored or explicitly overridden prompt is identified as such; its policy is not guessed from its text.

See the [tool catalog](../reference/tools.md#on-demand-tool-catalog) and [context compression](../guides/sessions.md#context-compression) for behavior and limitations. Fewer prompt bytes or tool definitions do not by themselves prove lower cost, faster completion, or better answers; tool selection adds requests and can change prompt-cache reuse.

## `services`

`services` configures two built-in services: web search (`moonshot_search`) and web fetch (`moonshot_fetch`). Only these two fixed keys are recognized; other keys are ignored. Both entries share the same fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `base_url` | `string` | No | Service API URL |
| `api_key` | `string` | No | API key |
| `oauth` | `table` | No | OAuth credential reference, same structure as `providers.*.oauth` |
| `custom_headers` | `table<string, string>` | No | Custom HTTP headers attached to each request |

`base_url` and `api_key` can also come from environment variables, which take priority over the config file: `KIMI_WEB_SEARCH_BASE_URL` / `KIMI_WEB_SEARCH_API_KEY` for `moonshot_search`, and `KIMI_WEB_FETCH_BASE_URL` / `KIMI_WEB_FETCH_API_KEY` for `moonshot_fetch`. An env base URL defines a separate service endpoint, so the persisted API key, OAuth reference, and custom headers are not forwarded to it; set the matching env API key when that endpoint requires authentication. An env API key without an env base URL keeps the configured endpoint and custom headers but replaces both configured credential forms. Setting the base URL and API key through env without any config section also enables the service.

```toml
[services.moonshot_search]
base_url = "https://api.moonshot.cn/v1/search"
api_key = "sk-xxx"

[services.moonshot_fetch]
base_url = "https://api.moonshot.cn/v1/fetch"
api_key = "sk-xxx"
```

## `permission`

`permission` sets permission rules that are automatically loaded when a session starts, controlling whether the Agent needs user confirmation before calling a tool. Rules are written as a `[[permission.rules]]` array of tables, matched in order — the first matching rule takes effect.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `decision` | `string` | Yes | Action on match: `allow` (permit immediately), `deny` (reject immediately), `ask` (prompt each time) |
| `scope` | `string` | No | Rule scope: `turn-override`, `session-runtime`, `project`, `user`; defaults to `user` |
| `pattern` | `string` | Yes | Match pattern in the form `ToolName` or `ToolName(arg-pattern)`, e.g. `Read` or `Bash(rm -rf*)` |
| `reason` | `string` | No | Rule description for debugging and auditing |

Built-in tool names are listed in [Built-in tools](../reference/tools.md). Most built-in tools that accept rule arguments define their own matching subject, such as `Bash(command-pattern)` or `Read(path-pattern)`. `AgentSwarm`, MCP tools, and custom tools can only be matched by tool name — argument patterns are not supported for them.

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
MCP server declarations are configured in `~/.hakimi/mcp.json` or the project-local `.kimi-code/mcp.json`, not in `config.toml`. The interactive configuration entry point is `/mcp-config`; see [Model Context Protocol](../customization/mcp.md).
:::

## `tui.toml`

Alongside `config.toml`, the CLI keeps terminal-UI and client preferences in a companion `tui.toml` in the same directory (`~/.hakimi/tui.toml`, or `$KIMI_CODE_HOME/tui.toml` when overridden). It is created with defaults on first run, and the interactive commands `/config`, `/theme`, and `/editor` write to it for you — so you rarely need to edit it by hand. If the file is malformed, the CLI falls back to defaults and shows a notice instead of failing to start.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `theme` | `string` | `auto` | Color theme: `auto` (follow the terminal), `dark`, `light`, or the name of a [custom theme](../customization/themes.md) |
| `render_latex` | `boolean` | `true` | Render LaTeX math expressions (`$…$`, `$$…$$`) in Markdown messages as Unicode text; `false` keeps the raw source |
| `disable_paste_burst` | `boolean` | `false` | Disable the non-bracketed paste-burst fallback that keeps rapid multi-line pastes from submitting line by line |
| `cache_expiry_hint` | `boolean` | `true` | Show a dialog when resuming a long-idle session or submitting after a long idle stretch, warning that the context cache has likely expired and offering to compact or start a new session (v2 engine only) |
| `[editor].command` | `string` | `""` | External editor command for composing long input; empty falls back to `$VISUAL` / `$EDITOR` |
| `[notifications].enabled` | `boolean` | `true` | Whether desktop notifications are sent |
| `[notifications].notification_condition` | `string` | `unfocused` | When to notify: `unfocused` (only when the terminal is not focused) or `always` |
| `[upgrade].auto_install` | `boolean` | `true` | Whether new versions are installed automatically |
| `[status_line].items` | `string[]` | `[]` | Built-in slots to show on the first footer line and their order: `mode`, `goal`, `model`, `preset`, `tasks`, `cwd`, `git`, `tips`. Unset keeps the default layout; unknown ids are skipped with a warning |
| `[status_line].command` | `string` | `""` | Custom status line command. Its first stdout line replaces the first footer line, with a JSON snapshot (model, subagent preset, cwd, git branch, permission mode, plan mode, context usage, session id, version) passed on stdin. Runs are capped at 300ms and throttled to once per second; failures fall back to the built-in layout |

```toml
# ~/.hakimi/tui.toml
theme = "auto" # "auto" | "dark" | "light" | custom theme name
render_latex = true # false keeps LaTeX math in messages as raw source
disable_paste_burst = false # true disables non-bracketed paste-burst fallback
cache_expiry_hint = true # false disables the "cache expired" dialog on resume / idle submit

[editor]
command = "" # empty uses $VISUAL / $EDITOR

[notifications]
enabled = true
notification_condition = "unfocused" # "unfocused" | "always"

[upgrade]
auto_install = true

# [status_line]
# items = ["mode", "goal", "model", "preset", "tasks", "cwd", "git", "tips"]
# command = "~/.hakimi/statusline.sh"
```

Changes apply on the next start, or immediately with `/reload-tui` (which reloads only `tui.toml`); `/reload` reloads both `config.toml` and `tui.toml`.

## Project-local configuration

In addition to the user-level files under `~/.hakimi`, Hakimi reads a project-local configuration file at `<project-root>/.kimi-code/local.toml`. It holds settings that are specific to one project checkout and typically should not be shared with teammates.

The file is created automatically when you add an extra workspace directory with [`/add-dir`](../reference/slash-commands.md) and choose to remember it for the project. You rarely need to edit it by hand.

### `[workspace]`

The `[workspace]` table groups project-level workspace settings:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `additional_dir` | `array<string>` | No | Additional workspace directories, stored as absolute paths. Written automatically when you confirm "remember this directory" in `/add-dir`; read back on startup so the directories are available in every session of this project |

```toml
[workspace]
additional_dir = ["/absolute/path/to/shared"]
```

Because directories are stored as absolute paths, which are specific to your machine, we recommend adding `.kimi-code/local.toml` to your project's `.gitignore` so it is not committed.

## Next steps

- [Providers and models](./providers.md) — connection examples for each provider type (Kimi, Claude, OpenAI, Gemini)
- [Config overrides](./overrides.md) — priority rules for CLI options, config file, and environment variables
- [Environment variables](./env-vars.md) — complete list of runtime variables like `KIMI_CODE_HOME`
