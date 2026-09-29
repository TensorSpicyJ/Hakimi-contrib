# @bhjia-phys/hakimi

> Hakimi is a truth-seeking research agent built on the Kimi Code runtime.

Hakimi keeps the terminal loop, tools, sessions, skills, MCP, subagents, permissions, and Kimi OAuth integration, while providing its own `hakimi` command, cat-ear spacecraft identity, `~/.hakimi` data home, release channel, and provider defaults. Its data-home resolution order is `HAKIMI_HOME` > `KIMI_CODE_HOME` > `~/.hakimi`.

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

Use `/login` in the TUI to authenticate with Kimi Code OAuth, a Kimi Platform API key, or a ChatGPT / OpenAI Codex OAuth account. Codex login provisions the `openai-codex/gpt-5.6-sol`, `openai-codex/gpt-5.6-terra`, and `openai-codex/gpt-5.6-luna` model aliases; OAuth login is always explicit and never starts at launch. Common entry points include:

```text
/help              Show commands and keyboard shortcuts
/model             Select a model
/sessions          Browse and resume sessions
/goal              Start or inspect autonomous goal work
/check-hakimi-docs Ask the built-in Hakimi manual skill
```

Use `hakimi -p "<instruction>"` for a non-interactive run and `hakimi -c` to resume the latest session.

## AITP Skills

Hakimi's default Research mode bundles AITP skills and reads scientific memory from the topic's `research.md` and linked files. Use `/research` or the Web topic panel to browse branches and inspect the current question.

The existing Goal and agent tools share that topic context. AITP governs the scientific workflow without a duplicate ledger or background memory writer. See [Research mode](../../docs/en/guides/research-mode.md) for configuration and scope.

## User manual

- [English getting started](../../docs/en/guides/getting-started.md)
- [中文开始使用](../../docs/zh/guides/getting-started.md)
- [CLI command reference](../../docs/en/reference/kimi-command.md)
- [Configuration and data locations](../../docs/en/configuration/data-locations.md)

Hakimi uses its own release version line (currently `0.21.x`), independently of upstream Kimi Code release tags.
