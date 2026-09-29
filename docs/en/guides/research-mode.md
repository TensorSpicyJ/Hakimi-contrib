# Research mode

Hakimi's v2 engine enables Research mode by default and bundles AITP skills for memory, research, writing, method distillation, brainstorming and learning. A topic's `research.md` and its linked derivations, code, literature and results are the scientific memory. Hakimi stores the selected note, mode preference and a Goal's original note path, without maintaining a second scientific summary.

## Open a topic

Start Hakimi in an existing topic directory. It locates the nearest `research.md` and presents its title, opening summary and nearby branches. Use `/research` to browse, `/research status` to inspect the current question, or `/research back` to return to the parent topic. `/research <note path>` selects an existing Markdown or TeX main note. A directory argument selects its `research.md`.

Press `←` in an empty terminal prompt to open the topic directory, then open the session's agent list to inspect delegated work. During streaming, `←` opens the agent directory directly. Use `/research agents` at any time to browse foreground and background agents. In agent details, press `←` to return to the directory; press `←` or `Esc` again to return to the prompt. The Web conversation displays a compact topic summary; expand it to preview the main note, enter branches or return to the parent topic. A subagent view has a direct return to the main agent.

Selecting a topic changes the session's research focus, not the tools' working directory. The note path in the interface and context identifies the actual topic location. Branches follow AITP's ordinary folders and reciprocally linked main notes, without mandatory headings, directory templates or extra ledgers. When no main note exists, `aitp-memory` determines whether to establish a persistent topic; a standalone question does not automatically create folders.

## Keep the research focused

Each new turn, automatic Goal continuation and recovery after context compaction receives a bounded excerpt of the selected main note. Full derivations and evidence remain available on demand, and subsequent context reflects note edits. `MEMORY.md`, `memory.md` and `memory_summary.md` are neither automatically discovered as scientific main notes nor accepted as topic selections. Repository coding rules in `AGENTS.md` still apply.

Research mode uses the existing Goal and `Agent` tools. The coordinator selects `research-theory`, `research-code`, `research-literature`, `research-review` or `research-writing` as useful, giving each worker a question, output location, acceptance evidence and stopping bound. Literature and review roles are read-only; the writing role edits its assigned documents. Workers share the selected topic, and the coordinator reconciles their results into the main note. Workers do not start independent continuous Goals.

Scientific workers reuse your existing [agent preset](../customization/agents.md) model and thinking settings. Theory falls back to `physicist`, then `thinker`; code uses `coder`; literature uses `librarian`, then `explore`; review and writing use `thinker`. Explicit `research-*` settings in the active preset or `[subagent.agents]` take precedence, field by field. Missing fields follow these fallback routes, then inherit the parent agent. Research mode does not select a provider or force a thinking level. The same routing applies when a worker resumes; an explicit `swarm` route keeps its usual priority for `AgentSwarm`.

Bundled AITP skills retain their existing responsibilities. LibRPA code tasks can also use `developing-librpa`. Skill references are readable on demand through `Read`. Tower's isolated code worktrees remain available when useful for code tasks; research does not require a fixed sequence of stages.

Changing the topic or mode is rejected while an agent or background task is running, or while a Goal is active. Pause the Goal and wait for running work to finish before switching. If the selected main note disappears, automatic Goal continuation waits for resolution instead of silently choosing another question.

A Goal retains the topic path selected when it was created. You can browse and select other topics after pausing, but resuming the old Goal under a different topic holds continuation without a model request. Return to the original topic before resuming, or explicitly establish the new topic's objective with `/goal replace`.

## Settings and scope

`/research off` disables the mode for the current session; `/research on` enables it again. Web provides the same toggle. To change the default for new sessions:

```toml
[research]
enabled = false
```

`KIMI_CODE_EXPERIMENTAL_RESEARCH=0` disables automatic research anchoring. Bundled AITP skills and scientific roles remain available for explicit use when the mode is off. The legacy v1 fallback engine does not provide the new mode.

Research mode helps preserve the question, evidence and task boundaries. It does not guarantee correct derivations or numerical convergence. A small model check does not establish a real-material result, and a finite-size conservation check does not prove an all-size theorem. The final conclusion and its conditions still need evidence in `research.md`.
