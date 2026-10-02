# @bhjia-phys/hakimi

> Hakimi is a truth-seeking research agent built on the Kimi Code runtime.

Hakimi keeps the terminal loop, tools, sessions, skills, MCP, subagents, permissions, and Kimi OAuth integration, while providing its own `hakimi` command, cat-ear spacecraft identity, `~/.hakimi` data home, release channel, provider defaults, and AITP-backed Research Mode. Its data-home resolution order is `HAKIMI_HOME` > `KIMI_CODE_HOME` > `~/.hakimi`.

## Install from this repository

Hakimi does not yet publish a public npm package or release install script. Building this repository requires Node.js 24.15.0 or later and pnpm 10.33.0:

```sh
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm install
pnpm build:packages
pnpm -C apps/kimi-code build
mkdir -p .tmp/dist-pack
pnpm -C apps/kimi-code pack --pack-destination ../../.tmp/dist-pack
npm install -g ./.tmp/dist-pack/bhjia-phys-hakimi-0.21.0.tgz
```

The tarball filename contains the current package version. If it has changed, use the filename printed by `pnpm pack` instead of `0.21.0`.

> On Windows, install [Git for Windows](https://gitforwindows.org/) before first launch because Hakimi uses the bundled Git Bash as its shell environment. If Git Bash is installed in a custom location, set `KIMI_SHELL_PATH` to the absolute path of `bash.exe`.

This package installs only the `hakimi` executable. It does not install a `kimi` alias, so a separate Kimi Code installation can keep owning the `kimi` command.

## First run

```sh
hakimi --version
cd /path/to/your/project
hakimi
```

Use `/login` in the TUI to authenticate with Kimi Code OAuth, a Kimi Platform API key, or a ChatGPT / OpenAI Codex OAuth account. Codex login provisions `openai-codex/gpt-6-sol`, `openai-codex/gpt-6-luna`, and `openai-codex/gpt-6-astra`, alongside the existing GPT-5.6 Sol, Terra, and Luna aliases. The first Codex login sets GPT-6 Sol as the default. For an already-configured Codex OAuth provider, startup and model-list refresh add missing built-in models without another login or changes to existing settings; an explicit `model_source = "static"` opts out. OAuth login is always explicit and never starts at launch. Common entry points include:

```text
/help              Show commands and keyboard shortcuts
/model             Select a model
/sessions          Browse and resume sessions
/goal              Start or inspect autonomous goal work
/check-hakimi-docs Ask the built-in Hakimi manual skill
```

Use `hakimi -p "<instruction>"` for a non-interactive run and `hakimi -c` to resume the latest session.

## Research Mode

Research Mode is a lightweight visibility toggle for the official [AITP](https://github.com/bhjia-phys/AITP-Research-Protocol) plugin `aitp`. Install the plugin first, then use `/research on`, `/research off`, or `/research status`; new sessions start with the mode off. Turning the mode on exposes the plugin's four core Skills — `aitp-memory`, `aitp-research`, `aitp-writing`, and `aitp-distill` — and turning it off hides them again without touching existing project knowledge.

AITP 1.1.0 has no CLI, ledger, runtime, or session hook: long-term memory is an editable research note (`research.md`, or an established TeX main note) that the agent reads and writes with ordinary file tools, entering through `aitp-memory`. Enabling the mode installs nothing, runs no external process, and writes no memory file; status reads, session restore, and turn boundaries stay local. Ordinary Goal, Plan, and permission behavior is unchanged.

For prerequisites, the workflow, and the remaining boundaries, see the [English Research Mode guide](../../docs/en/guides/research-mode.md) or [中文研究模式指南](../../docs/zh/guides/research-mode.md).

## User manual

- [English getting started](../../docs/en/guides/getting-started.md)
- [中文开始使用](../../docs/zh/guides/getting-started.md)
- [CLI command reference](../../docs/en/reference/kimi-command.md)
- [Configuration and data locations](../../docs/en/configuration/data-locations.md)

Hakimi uses its own release version line (currently `0.21.x`), independently of upstream Kimi Code release tags.
