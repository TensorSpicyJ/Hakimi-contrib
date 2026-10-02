/**
 * Background (handed-off) session output projection.
 *
 * Folds the SDK event stream of a session this process adopted from another
 * session's handoff into a bounded plain-text log and a coarse status, so the
 * TUI can show what that session is doing without touching the foreground
 * transcript. Deliberately independent of `streaming-ui` / `session-event-
 * handler`: a background session's output must never be rendered into the
 * session on screen. Pure — no UI state, no rendering, no RPC.
 */

import type { Event, Session } from '@bhjia-phys/hakimi-sdk';

/** Coarse lifecycle of a background session, as the TUI displays it. */
export type BackgroundSessionStatus = 'idle' | 'running' | 'waiting' | 'failed';

/** Only the interactive agent's own output belongs to the session's log. */
const MAIN_AGENT_ID = 'main';
const MAX_OUTPUT_LINES = 2_000;
const MAX_LINE_CHARS = 4_000;
const MAX_PARTIAL_CHARS = 32_000;

export interface BackgroundSessionOutput {
  /** Completed lines, oldest first. */
  readonly lines: string[];
  /** The in-flight assistant text, not yet in `lines`. */
  streaming: string | undefined;
  status: BackgroundSessionStatus;
}

export function createBackgroundSessionOutput(prompt: string): BackgroundSessionOutput {
  return {
    lines: [`Task: ${singleLine(prompt)}`],
    streaming: undefined,
    // No turn has been observed yet. A handoff whose first prompt never ran
    // (blocked, failed, cancelled before submission) stays `idle` — the viewer
    // and the picker must not claim progress such a session never made. The
    // authoritative failure message is the `StartSession` tool result, not this
    // label.
    status: 'idle',
  };
}

/** Folds one SDK event into the log. Unknown and subagent events are ignored. */
export function foldBackgroundSessionEvent(output: BackgroundSessionOutput, event: Event): void {
  if (event.agentId !== MAIN_AGENT_ID) return;
  switch (event.type) {
    case 'turn.started':
      output.status = 'running';
      return;
    case 'assistant.delta':
      output.streaming = appendChunk(output.streaming, event.delta);
      output.status = 'running';
      return;
    case 'thinking.delta':
      output.status = 'running';
      return;
    case 'tool.call.started': {
      flushPartial(output);
      output.lines.push(`· ${toolLine(event.name, event.description)}`);
      output.status = 'running';
      break;
    }
    case 'background.task.started': {
      flushPartial(output);
      output.lines.push(`· background task ${event.info.taskId}: ${event.info.description}`);
      output.status = 'running';
      break;
    }
    case 'background.task.terminated': {
      flushPartial(output);
      output.lines.push(`· background task ${event.info.taskId} ${event.info.status}`);
      break;
    }
    case 'turn.ended': {
      flushPartial(output);
      if (event.reason !== 'completed') {
        output.lines.push(`· turn ended: ${event.reason}`);
      }
      output.lines.push('');
      output.status = event.reason === 'completed' ? 'idle' : 'failed';
      break;
    }
    case 'error': {
      flushPartial(output);
      output.lines.push(`! ${event.message}`);
      output.status = 'failed';
      break;
    }
    case 'warning': {
      flushPartial(output);
      output.lines.push(`! ${event.message}`);
      break;
    }
    default:
      return;
  }
  trimLines(output.lines);
}

/** The viewer's document: the finished lines plus the in-flight tail. */
export function backgroundSessionText(output: BackgroundSessionOutput): string {
  const lines = [...output.lines];
  if (output.streaming !== undefined && output.streaming.length > 0) {
    lines.push(...output.streaming.split('\n'));
  }
  return lines.join('\n');
}

/** The picker / viewer label of a background session: project plus title. */
export function backgroundSessionLabel(session: Session, workDir: string): string {
  const title = session.summary?.title?.trim();
  return title !== undefined && title.length > 0 ? `${workDir} · ${title}` : workDir;
}

/** The status a background session currently shows, pending requests winning. */
export function backgroundSessionStatusLabel(
  output: BackgroundSessionOutput,
  pendingRequests: number,
): BackgroundSessionStatus {
  if (pendingRequests > 0) return 'waiting';
  return output.status;
}

function flushPartial(output: BackgroundSessionOutput): void {
  const partial = output.streaming;
  output.streaming = undefined;
  if (partial === undefined || partial.trim().length === 0) return;
  output.lines.push(...partial.split('\n'));
  trimLines(output.lines);
}

function appendChunk(current: string | undefined, delta: string): string {
  const next = (current ?? '') + delta;
  return next.length > MAX_PARTIAL_CHARS ? next.slice(next.length - MAX_PARTIAL_CHARS) : next;
}

function trimLines(lines: string[]): void {
  while (lines.length > MAX_OUTPUT_LINES) lines.shift();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.length > MAX_LINE_CHARS) {
      lines[i] = `${line.slice(0, MAX_LINE_CHARS)}…`;
    }
  }
}

function toolLine(name: string, description: string | undefined): string {
  const detail = description === undefined ? '' : singleLine(description);
  return detail.length > 0 ? `${name} — ${detail}` : name;
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}
