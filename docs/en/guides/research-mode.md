# Research Mode

Research Mode keeps two things useful across research sessions: **local knowledge — what we know now**, and **long-term memory — how we got here**. It does not manage every scientific step or require a research board before you can work.

::: warning
Research Mode targets the official [AITP](https://github.com/bhjia-phys/AITP-Research-Protocol) plugin **1.1.0** (plugin id `aitp`, source commit `0f6dc4cdea09106a46d53cf6355b09a924d8e21b`, manifest build `1.1.0+codex.20260914182315`). The plugin is installed locally as a managed plugin, and the mode gates its four core Skills — `aitp-memory`, `aitp-research`, `aitp-writing`, and `aitp-distill`. AITP 1.1.0 has **no CLI, no ledger, and no session hook**: memory is an editable research note the agent reads and writes with ordinary file tools. This is a major-version replacement of the former adapter integration, so no historical data is migrated automatically. The managed copy came from a downloaded source archive, not a Git checkout or release tag, and that archive ships no CLI, so there is no `aitp --help` check to run. Newly started `hakimi` processes use the built workspace output; already-running processes need a restart to load it, and no user session was force-restarted. See the [current compatibility amendment](../../aitp/compatibility-matrix.md#aitp-plugin-1-1-0-20260915).
:::

## Local knowledge and long-term memory

The two layers answer different questions without creating a second research database in Hakimi.

- **Local knowledge** describes the current understanding: conclusions, assumptions, open questions, sources, and applicable limits. The agent reads and updates ordinary project files with `Read`, `Grep`, `Glob`, `Edit`, and `Write`.
- **Long-term memory** preserves worthwhile progress: the evidence behind a result, failed approaches, changes in understanding, consequential decisions, and reusable methods. Official AITP Skills guide the agent in entering the topic, recovering its argument, and retaining meaningful changes in the topic's main note and linked detailed notes.

Start from the existing project's `AGENTS.md` and `README` indexes. Keep its file names and organization; Research Mode imposes no new directory template and does not create a knowledge store in a parent workspace. AITP reuses the topic's established layout — typically a `research.md` main note, where an existing TeX main note also counts — with linked supporting notes and assets, rather than a fixed `knowledge/` layout. Existing knowledge remains useful even when AITP is unavailable or the mode is off.

A summary should retain links to sources and artifacts, distinguish evidence from interpretation, and state what remains uncertain. Neither a saved note nor a concise knowledge page certifies scientific correctness.

## Turning Research Mode on and off

The switch controls lightweight research guidance and visibility of the official AITP Skills, not permission to perform ordinary research work.

| Command | Purpose |
| --- | --- |
| `/research on` | Enable the lightweight mode and make the discovered official AITP Skills visible |
| `/research off` | Disable the mode and hide those Skills; preserve existing knowledge and memory |
| `/research status` | Read the local mode status without running any AITP process |

New sessions start with Research Mode off. Turning it on does not install AITP, initialize a store, probe an external process, write any memory file, or schedule another model turn. Status reads, session restore, and ordinary turn boundaries do not trigger AITP maintenance or memory writes either. An on/off status is not proof that AITP is installed.

In Hakimi Web, the `/` menu refreshes when Research Mode changes, including changes made by another client and after reconnecting. Open the Research panel to see the installed AITP version and the core Skills actually returned for this session. Invoke one with `/skill:aitp-memory` followed by your request, or choose it from the menu. The panel distinguishes missing, disabled, and errored plugins; failed metadata reads or missing versions show unknown/unavailable rather than a guessed version. Installation and mode state do not guarantee that every Skill is available.

There is no separate research-management or advancement command workflow. The old Line, Question, Action, alignment, and checkpoint commands are no longer supported; historical records do not enable a second legacy execution mode. Exact additional interface details must be checked against the implemented backend rather than inferred from old command lists.

## Working with knowledge and memory

Work normally, then save only what changes the useful record. No registration of a Line or Question, Action lifecycle, or host checkpoint is required before a search, calculation, discussion, or file edit.

1. Read relevant knowledge through the project's existing indexes. Enter through `aitp-memory` when you are starting or resuming a research topic, even if the request is a derivation, a calculation, or an analysis rather than a recording task.
2. Perform the task using ordinary tools and the existing permission rules. Preserve enough source and artifact references to explain the result and its limits.
3. If there is new knowledge or progress worth remembering, update the relevant project summary or the topic's research note as the relevant AITP Skill directs. Confirm the intended topic and record scope; do not infer ownership from similar names or paths.
4. Report what was actually saved, where it was saved, and what remains unverified. If saving fails, retain the useful local evidence and say that long-term memory was not saved; do not invent a receipt or silently widen the scope.

A normal follow-up, rephrasing, status question, or repeated explanation with **no meaningful delta causes no knowledge or memory writes**. Opening the mode, loading a Skill, finishing a turn, or completing a Goal is not itself a reason to save. Stage synthesis or a reusable lesson may be worth remembering without a new calculation, but should not be manufactured to satisfy a reporting ritual.

For example, asking why an existing approximation is valid usually needs only a read and an explanation. Discovering that it fails in a specific regime may justify a knowledge correction and a note that links the counterexample, assumptions, and limits. The distinction is useful new information, not tool count or conversation length.

## Official AITP Skills

AITP is the external protocol authority, not a native Hakimi service. Its four core Skills cover the whole topic: `aitp-memory` enters the topic and decides what to retain, `aitp-research` guides physical reasoning, literature use, and computation, `aitp-writing` develops the main note and its explanations, and `aitp-distill` teaches a demonstrated reusable procedure. Hakimi does not copy their full content or add a post-save distillation coordinator.

To use long-term memory, the deployment must make the official plugin available in the session's [skill catalog](../customization/skills.md). Install the plugin with `/plugins install https://github.com/bhjia-phys/AITP-Research-Protocol/releases/download/v1.1.0/aitp-1.1.0.zip` and start a new host thread, or follow the [upstream instructions at the pinned source](https://github.com/bhjia-phys/AITP-Research-Protocol/tree/0f6dc4cdea09106a46d53cf6355b09a924d8e21b). Hakimi discovers the four bundled Skills; nested domain methods under `aitp-research` stay a method library rather than separate Skills. Research Mode does not automatically install or initialize anything.

AITP 1.1.0 ships no Python runtime, ledger CLI, knowledge-card layer, hash protocol, search service, MCP service, hook, or background daemon. The topic's memory is ordinary Markdown and TeX that the agent reads and edits with the host's existing tools, and Git is ordinary source version control rather than a required memory protocol. Reading a research note does not certify its scientific correctness or authorize its recorded next action. Human decisions, method approval, and publication remain subject to the official protocol; Hakimi does not supply them automatically. Missing AITP support does not prevent local knowledge work and must not be reported as a successful memory save.

## Goal, Plan, and permissions

Research Mode is independent of the ordinary [Goal](./goals.md), [Plan mode](../reference/tools.md#plan-mode), and tool permission systems. Goal still owns cross-turn continuation, budgets, and completion. Plan still organizes work under its usual rules. Enabling or disabling Research Mode neither creates nor resumes a Goal, changes permissions, nor adds a Research-specific completion or continuation veto.

The old host Action-ownership and canonical-file vetoes are retired. Ordinary file tools therefore have **no additional Research-specific guarantee preventing direct access to a topic's memory files**. Following the official Skills' file conventions is a protocol rule, not an executor barrier or operating-system isolation. Existing file-access policies, tool approvals, and any configured sandbox remain the actual host boundaries; turning the mode off is not a security boundary either.

The optional `theory-physics` domain guidance can still help with assumptions, derivations, numerical checks, and evidence reporting. It is not a second runtime or a requirement to register every scientific step. Scientific judgment remains with the researcher.

## Historical records and retired controls

This is a change of architecture, not a smaller Research Board. Production no longer mounts the host ResearchService, Line/Question/Action management, Research Plan, checkpoint machinery, Research Loop, automatic maintenance, distillation orchestration, Research Goal veto, or native AITP adapter.

The eight built-in wrappers — `aitp_enter`, `aitp_list`, `aitp_show`, `aitp_check`, `aitp_record_prepare`, `aitp_record_save`, `aitp_note_prepare`, and `aitp_note_save` — are retired. Use ordinary file tools for project knowledge and the official AITP Skills for long-term memory instead. Older Entry/Note files and stores are neither deleted nor migrated; the retired CLI that produced them is no longer part of AITP, and no automatic backfill or conversion is performed.

For SDK snapshot, event, and command changes, see the [migration guide](../release-notes/breaking-changes.md#research-mode-and-sdk-research-apis). Old Research state and records remain readable through raw session logs or session exports, not a structured Research history API or Manager. They are not resumed as live Actions, pending checkpoints, bindings, or a parallel legacy workflow; old mutations are unsupported. Conversation undo neither changes the new mode switch nor undoes edits the Skills made through ordinary file tools.

## Local installation and remaining checks

The [tracking amendment](../../aitp/TRACKING.md#aitp-plugin-1-1-0-20260915) records the completed suites and reviews, the local build, the managed AITP 1.1.0 installation, and the no-model smoke. The implementation is installed locally: the CLI wrapper points at the built workspace output, so newly started `hakimi` processes use it, while already-running processes need a restart and none were force-restarted. The plugin itself is installed from a downloaded source archive rather than a Git checkout; because 1.1.0 removed the CLI, no command-line health check exists and none is claimed. An isolated real server-plus-browser check now verifies mode toggles, the four Skill menu entries, installed version display, and responsive light/dark layouts without model requests; see the [Web verification record](../../aitp/TRACKING.md#web-research-skills-20260916). This is not end-to-end scientific or model-behavior acceptance. No version bump, tag, publish, or formal release has been performed. These remaining boundaries do not imply the user-facing Research Mode workflow is undelivered, and none of this certifies a scientific claim.
