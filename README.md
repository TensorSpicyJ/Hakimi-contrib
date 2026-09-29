# Hakimi

<p align="center">
  <img src="docs/assets/hakimi-terminal-welcome.png" width="920" alt="Hakimi terminal welcome screen with a pixel cat-ear exploration spacecraft" />
</p>

<p align="center">
  <strong>A theoretical-physics research agent built for one objective: truth.</strong><br />
  <span>Truth is the objective. Evidence is the boundary. Reproducibility is the test.</span>
</p>

<p align="center">
  <a href="README.zh-CN.md">中文</a> |
  <a href="https://github.com/bhjia-phys/Hakimi">Repository</a> |
  <a href="docs/en/guides/getting-started.md">User manual</a> |
  <a href="LICENSE">License</a>
</p>

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Why Hakimi

Hakimi is not a machine for producing one-shot answers. It is built to pursue a theoretical-physics question through bounded work: state assumptions, seek disconfirming evidence, distinguish a result from its uncertainty, and choose the next test that can decide something.

Its terminal, code, search, tests, and subagents are research instruments—not its identity. Hakimi does not optimize for busywork or engineering complexity. It begins with the simplest useful model and prefers the smallest decisive check over a larger, less discriminating construction.

## The research loop

```text
Question
  → Bounded action
  → Evidence
  → Result and uncertainty
  → Next discriminating step
```

A question becomes research only when an action can change what should be believed or done next. Hakimi keeps this loop explicit: each action is bounded, each result records its limits, and each next step is selected for its capacity to discriminate between live possibilities.

## What is implemented

- **Science-first progress:** work is organized around evidence and uncertainty rather than tool activity or transcript volume.
- **Review and human control:** human review and reproducible verification remain necessary for scientific judgment.
- **External-compute analysis:** Hakimi can help analyze external HPC work, but it does not schedule jobs, poll them to completion, or certify success.

## Theory-physics discipline

AITP skills are bundled with Hakimi's default Research mode. A topic's `research.md` and linked files retain the scientific argument; AITP's own instructions govern memory, research and writing.

Hakimi supplies topic navigation, shared agent context and Goal continuity around those files. Researchers retain responsibility for conventions, significance and scientific judgment.

## Evidence before confidence

Hakimi can help construct arguments, calculations, code, searches, and tests. None of these alone authenticates a physical claim. Hakimi does not certify physical correctness, numerical convergence, or the success of a running external task.

Human review and reproducible verification are part of the research loop, not a final cosmetic step. When the evidence is insufficient or conflicts, the honest result is uncertainty, a blocked question, or a smaller discriminating check.

## AITP Skills

The bundled AITP skills use the ordinary `Skill` and `Read` tools. `/research` opens topic navigation; the Web topic panel presents the main question and related branches. See [Research mode](docs/en/guides/research-mode.md) for controls and scope.

There is no duplicate scientific ledger or background memory writer. Follow AITP's instructions to retain meaningful evidence in the existing topic files. The former ledger adapter remains retired; its history is in [the AITP documentation](docs/aitp/).

## Install from source

Hakimi currently installs from source. Use Node.js 24.15.0 or newer and pnpm 10.33.0:

```sh
git clone https://github.com/bhjia-phys/Hakimi.git
cd Hakimi
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm install
pnpm build:packages
pnpm -C apps/kimi-code build
mkdir -p .tmp/dist-pack
pnpm -C apps/kimi-code pack --pack-destination ../../.tmp/dist-pack
npm install -g "$(ls -t ./.tmp/dist-pack/*.tgz | head -n 1)"
hakimi --version
```

`pnpm pack` prints the tarball filename it creates; the command above selects the newest tarball in `.tmp/dist-pack`. To update a source installation, pull the desired revision and repeat the build, pack, and install steps.

Start an interactive session, run one prompt, or continue the previous session:

```sh
hakimi
hakimi -p "Summarize the test failures in this repository."
hakimi -c
```

Use `/login` to configure an available provider. For DeepSeek setup, run `hakimi provider deepseek`. Login is explicit; Hakimi never begins OAuth login at startup. Configuration, sessions, logs, and caches live under `~/.hakimi` by default; set `HAKIMI_HOME` to use another data directory.

On Windows, install [Git for Windows](https://gitforwindows.org/) before first launch. Hakimi uses its bundled Git Bash shell; if Git Bash is installed elsewhere, set `KIMI_SHELL_PATH` to the absolute path of `bash.exe`.

## Current status

- Hakimi is a development version that can be built from source.
- Independently installed plugins and Skills follow the ordinary discovery and tool path.
- There is no public npm package or release installer; use the source-build path above.
- Hakimi does not replace expert judgment, human review, or reproducible scientific validation.

## Documentation

- [Getting started](docs/en/guides/getting-started.md)
- [Configuration](docs/en/configuration/config-files.md)
- [AITP retirement records](docs/aitp/)
- [Implementation notes](IMPLEMENTATION.md)

## Project background

Hakimi is an independent repository with its own `hakimi` command, `~/.hakimi` data directory, semver release line, and research direction. It selectively builds on engineering foundations from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code), but it is not a product-parity fork and does not adopt upstream behavior automatically.

The historical source and attribution context remain in [`bhjia-phys/Hakimi-upstream-archive`](https://github.com/bhjia-phys/Hakimi-upstream-archive). See the [MIT license](LICENSE) for required attribution.

## Development

From the repository root:

```sh
corepack pnpm --config.engine-strict=false install
corepack pnpm --config.engine-strict=false -C apps/kimi-code typecheck
corepack pnpm --config.engine-strict=false -C apps/kimi-code test
```

The CLI lives in `apps/kimi-code`; packages provide the SDK, model/provider integrations, and agent runtime used by the application.

## License

MIT. See [LICENSE](LICENSE). Hakimi retains the required attribution for upstream Kimi Code work by Moonshot AI.
