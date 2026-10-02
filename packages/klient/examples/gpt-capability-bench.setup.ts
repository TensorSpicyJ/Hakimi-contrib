/** Deterministic, credential-free host setup for the capability benchmark. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CapabilityHomeOptions {
  model: string;
  effort: string;
  contextWindow: number;
}

/** A minimal MCP stdio server: no packages, network, environment reads, or randomness. */
export const BENCH_MCP_SOURCE = String.raw`
import { createInterface } from 'node:readline';
const calibration = { id: 'calibration-v1', unit: 'mV', slope: 2.5, intercept: -1, source: 'bench-calibration-2026-01' };
for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (request.id === undefined) continue;
  let result;
  let error;
  if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'bench-fixed-calibration', version: '1.0.0' } };
  else if (request.method === 'ping') result = {};
  else if (request.method === 'tools/list') result = { tools: [{ name: 'lookup', description: 'Read the fixed calibration registry. Query calibration-v1 for the mV calibration coefficients and source identifier.', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }] };
  else if (request.method === 'tools/call') {
    const valid = request.params?.name === 'lookup' && request.params?.arguments?.key === 'calibration-v1';
    result = { content: [{ type: 'text', text: valid ? JSON.stringify(calibration) : 'Unknown calibration key or tool' }], isError: !valid };
  } else error = { code: -32601, message: 'Method not found' };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result, error }) + '\n');
}
`;

export async function prepareCapabilityHome(
  home: string,
  options: CapabilityHomeOptions,
  task: { id: string },
): Promise<void> {
  if (!Number.isSafeInteger(options.contextWindow) || options.contextWindow <= 0) throw new Error('Invalid context window');
  const hakimi = join(home, 'hakimi');
  await mkdir(hakimi, { recursive: true });
  await writeFile(join(hakimi, 'config.toml'), [
    'default_model = "bench"',
    '[models.bench]',
    `name = ${JSON.stringify(options.model)}`,
    'protocol = "openai_responses"',
    'base_url = "http://chatgpt.com:48631/backend-api/codex"',
    'api_key = "benchmark-placeholder"',
    `max_context_size = ${options.contextWindow}`,
    'support_efforts = ["low", "medium", "high", "xhigh", "max", "ultra"]',
    `default_effort = ${JSON.stringify(options.effort)}`,
    '[subagent.auto_preset]',
    'enabled = false',
    '',
  ].join('\n'));
  // The user-level file is trusted by the runtime; a project .mcp.json would require
  // an unrelated trust interaction. Both arms receive precisely this same fixture.
  if (task.id.startsWith('F02')) {
    await writeFile(join(hakimi, 'bench-mcp.mjs'), BENCH_MCP_SOURCE);
    await writeFile(join(hakimi, 'mcp.json'), JSON.stringify({ mcpServers: {
      bench: { transport: 'stdio', command: '/runtime/bin/node', args: ['/home/bench/hakimi/bench-mcp.mjs'], startupTimeoutMs: 10000, toolTimeoutMs: 10000 },
    } }, null, 2));
  }
}
