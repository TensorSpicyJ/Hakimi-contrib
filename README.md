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

Post-commit Note review keeps the verified source Line/Topic/workstream confirmation and rechecks it at actual Note-tool execution. Switching Line, rebinding, losing readiness, undo, or restore cannot reuse an old draft's write permission. A restored review marker alone remains read-only. Stage synthesis and interrupted review can use a fresh bounded Note Action: the host verifies the selected Question evidence through canonical Entry reads before preparing or saving a new draft, without requiring a fabricated scientific delta. This local protection is not AITP's atomic Entry compare-and-save and adds no automatic card approval, publication, or distillation coordinator.

When AITP is degraded, user-directed Research turns may still perform provisional exploration inside a fresh bounded Action with the normal scope and permission checks. Automatic Goal work, AITP writes and Goal completion remain held. A new result or failure with confirmed record ownership stays a local pending candidate until recovery; it is not silently reclassified as no-delta. This fixes the conflict between allowing local Research actions and refusing all their work tools.

Opening Research Mode within a user turn now starts its Research context and one local boundary as entry settles, without requiring another prompt. Pause/exit revokes admission; mode recovery never grants autonomous Goal continuation.

Saving evidence does not itself update the scientific Question. Durable-action guidance finishes the captured checkpoint first, then the first successful commit prompts conditional synthesis for the still-current Question: assessment, relevant evidence, remaining unknowns, and next action. Duplicate commits or changed context do not repeat that targeted prompt. The model performs this synthesis through the existing Question tool; receipts never automatically promote scientific confidence or close a Question.

The current Question respects explicit Focus. Without Focus, it can use the foreground Action's explicit Question on the current Line, without setting Focus or guessing ownership. After higher-priority action, run, decision and persistence work settles, the Question's explicit next step takes precedence over historical progress. Snapshot, status and post-commit guidance share that context. See the [Question-context repair and verification status](docs/aitp/theory-physics-collaborator-program.md#question-context-projection).

For a stage Note from existing evidence, the model should settle the Question's canonical evidence references before beginning its Note Action, since Begin captures that revision. The existing context also identifies completed native scoped maintenance when its Topic and confirmed binding match; Skill loading alone does not require another `enter/check`. Evidence review, genuine stale-state refresh, and required save verification remain necessary. These are guidance corrections, not new phases or automatic scientific judgments.

The optional Theory Physics plugin includes a `calculation-operator` agent profile for bounded build, input, numerical and postprocessing work. The main agent supplies the scientific test and scope, reviews the existing typed evidence packet, and owns all Research/AITP mutations. This role is distinct from the `/preset` model-routing pool; it installs no runner or scheduler and provides no OS-level isolation. Real scientific acceptance is tracked separately in the collaborator program.

Theory Physics 0.2.3 exposes delegation guidance directly in the calling researcher's available-agent description: pass the whole task's remaining time and reserve parent review/closeout, then request one saved packet with a brief return or one inline packet. The specialist's detailed instructions remain separate; the caller need not read its full prompt to see these essentials. Requested packet saving and evidence-backed failure reporting remain required: an unattempted write is not proof of a missing tool, and a failed handoff does not erase a numerical result. These are instructions, not a runtime deadline or a guarantee that a model will follow them.

The checkpoint barrier also compares the saved Entry's kind, authority and creator with the concluded candidate before accepting it. A mismatch retains the saved record and receipt for review, leaves the checkpoint pending, and prevents the post-commit distillation handoff. This is a post-save identity check, not a semantic validation or an atomic pre-save authority guarantee.

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
