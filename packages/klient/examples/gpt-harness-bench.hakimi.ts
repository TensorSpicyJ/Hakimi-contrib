/** Runs the production Hakimi profile inside the harness benchmark's isolated filesystem. */
import { readFile } from 'node:fs/promises';
import { bootstrap, logSeed, resolveLoggingConfig } from '@moonshot-ai/agent-core-v2';
import { createKlient } from '@moonshot-ai/klient/memory';

interface Plan {
  model: string;
  effort: string;
  sessionId?: string;
  patch: boolean;
  catalog?: boolean;
  maxRequests: number;
}

async function main(): Promise<void> {
  const plan = JSON.parse(await readFile('/run/plan.json', 'utf8')) as Plan;
  let prompt = '';
  for await (const chunk of process.stdin) prompt += String(chunk);
  if (prompt.length === 0) throw new Error('A current-turn prompt is required on stdin');
  const homeDir = '/home/bench/hakimi';
  const env = {
    PATH: process.env['PATH'],
    HOME: '/home/bench',
    KIMI_CODE_EXPERIMENTAL_APPLY_PATCH: String(plan.patch),
    KIMI_CODE_EXPERIMENTAL_TOOL_CATALOG: String(plan.catalog === true),
    KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL: 'false',
    KIMI_LOOP_MAX_STEPS_PER_TURN: String(plan.maxRequests),
    KIMI_LOOP_MAX_ATTEMPTS_PER_STEP: '1',
  };
  const { app } = bootstrap(
    { homeDir, cwd: '/workspace', env, clientIdentity: { productName: 'Hakimi', version: 'harness-bench', platform: 'linux' } },
    [...logSeed(resolveLoggingConfig({ homeDir, env }))],
  );
  const klient = createKlient({ scope: app });
  try {
    const sessionId = plan.sessionId ?? (await klient.global.sessions.create({ workDir: '/workspace', title: 'Harness evaluation' })).id;
    const handle = klient.session(sessionId);
    if (plan.sessionId !== undefined && !(await handle.restore())) throw new Error('Session restore failed');
    const agent = handle.agent('main');
    if (plan.sessionId === undefined) {
      await agent.setModel('bench');
      await agent.setThinking(plan.effort);
      await agent.setPermission('yolo');
    }
    process.stdout.write(JSON.stringify({ type: 'session.started', sessionId }) + '\n');
    try {
      let finish: (reason: string) => void = () => {};
      const ended = new Promise<string>((resolvePromise) => { finish = resolvePromise; });
      const subscriptions = [
        agent.events.on('turn.ended', (event) =>{  finish(event.reason); }),
        agent.events.on('prompt.aborted', () =>{  finish('aborted'); }),
      ];
      try {
        await agent.prompt({ input: [{ type: 'text', text: prompt }] });
        const reason = await ended;
        process.stdout.write(JSON.stringify({ type: 'turn.ended', reason }) + '\n');
        const context = await agent.getContext();
        const names = new Map<string, string>();
        for (const message of context.history) {
          for (const call of message.toolCalls) {
            if (call.name === 'TodoList' || call.name === 'select_tools') names.set(call.id, call.name);
          }
        }
        const successes: Record<string, number> = {};
        for (const message of context.history) {
          const name = message.toolCallId === undefined ? undefined : names.get(message.toolCallId);
          if (message.role === 'tool' && message.isError !== true && name !== undefined) {
            successes[name] = (successes[name] ?? 0) + 1;
          }
        }
        process.stdout.write(JSON.stringify({ type: 'tools.completed', successes }) + '\n');
        if (reason !== 'completed') throw new Error(`Turn ended: ${reason}`);
      } finally {
        for (const sub of subscriptions) sub.dispose();
      }
    } finally { await handle.close(); }
  } finally {
    await klient.close();
    app.dispose();
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
