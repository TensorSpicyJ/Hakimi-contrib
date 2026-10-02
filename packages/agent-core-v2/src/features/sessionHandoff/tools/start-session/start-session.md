Start an independent new session in another project directory and hand it a task.

When a task would benefit from a separate session in another project, proactively propose the target project and the task to hand off. Before calling this tool, ask the user to confirm using AskUserQuestion (or a plain question if unavailable), and wait for their answer. If the user already explicitly requested creating and starting that session with a clear target and task, that request is sufficient confirmation — do not ask twice. Tool auto-approval or YOLO mode does not replace this confirmation of the handoff itself.

The new session runs as an ordinary session in that project: it loads that project's own rules, Skills, and MCP configuration, and it uses its own default model, profile, permission mode, and Plan setting. It does not inherit this conversation, this session's history, its temporary directory permissions, its approval memory, or its Goal state.

The tool returns as soon as the task is submitted. It does not wait for the task to finish — the new session keeps running on its own, even after this turn ends. Report the returned session id and status to the user instead of waiting, and do not poll the session in a loop.

Requirements:
- `work_dir` must be an absolute path to an existing directory on this machine, and the project there must already be trusted. This tool never marks a directory trusted; if the target is untrusted, tell the user to open or trust that project first. Checking the target does not create the session or submit the task, but it may make that directory known to this host's workspace list.
- `prompt` must be self-contained: goal, background, constraints, and acceptance criteria. The new session sees nothing from this conversation.
- Pass a short `title` so the user can find the new session in their session list.

Do not use this tool to work around a directory restriction, a missing permission, or a denial in the current session. A failed command or a path outside the current project is not authorization to create a session. If the user declines or has not confirmed a proposed handoff, do not create it; continue within the current session's authorized scope.

A failure before the session exists only prevents the task from running; it does not promise the host state is untouched. If the tool reports a failure after the session was created, the session exists: tell the user its id and the real failure reason. Never delete or recreate it on your own.
