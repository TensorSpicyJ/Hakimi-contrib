/** Append-only, fsync-before-dispatch accounting. An interrupted reservation is never refunded. */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export interface BatchCaps {
  maxRuns: number;
  maxRequests: number;
  timeoutMs: number;
  maxObservedTokens: number;
}
interface LedgerEvent {
  sequence: number;
  kind: 'opened' | 'run' | 'request' | 'usage' | 'finished';
  at: number;
  runId?: string;
  tokens?: number;
  caps?: BatchCaps;
  identity?: string;
}

export class BatchLedger {
  private readonly path: string;
  private readonly events: LedgerEvent[];
  readonly startedAt: number;
  constructor(root: string, readonly caps: BatchCaps, identity: string, mustExist = false) {
    for (const value of Object.values(caps)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid finite batch cap');
    this.path = join(root, 'ledger.jsonl');
    this.events = [];
    if (mustExist && !existsSync(this.path)) throw new Error('Resume ledger is missing; refusing to reset the budget');
    if (existsSync(this.path)) {
      const text = readFileSync(this.path, 'utf8');
      if (!text.endsWith('\n')) throw new Error('Truncated ledger: fail closed; reservations cannot be reconstructed');
      const reserved = new Set<string>();
      const finished = new Set<string>();
      let requests = 0;
      for (const line of text.trimEnd().split('\n')) {
        const event = JSON.parse(line) as LedgerEvent;
        if (event.sequence !== this.events.length || !['opened', 'run', 'request', 'usage', 'finished'].includes(event.kind) || !Number.isSafeInteger(event.at) || event.at < 0) throw new Error('Corrupt ledger');
        if (event.kind === 'opened') {
          if (this.events.length !== 0) throw new Error('Corrupt ledger: reopened budget');
        } else {
          if (typeof event.runId !== 'string' || event.runId.length === 0) throw new Error('Corrupt ledger: missing run id');
          if (event.kind === 'run') {
            if (reserved.has(event.runId) || reserved.size >= caps.maxRuns) throw new Error('Corrupt ledger: duplicate or excessive run reservation');
            reserved.add(event.runId);
          } else {
            if (!reserved.has(event.runId) || finished.has(event.runId)) throw new Error('Corrupt ledger: invalid run lifecycle');
            if (event.kind === 'request' && ++requests > caps.maxRequests) throw new Error('Corrupt ledger: excessive requests');
            if (event.kind === 'usage' && (!Number.isSafeInteger(event.tokens) || event.tokens! < 0 || !this.events.some((e) => e.kind === 'request' && e.runId === event.runId))) throw new Error('Corrupt ledger: invalid usage');
            if (event.kind === 'finished') finished.add(event.runId);
          }
        }
        this.events.push(event);
      }
      const first = this.events[0];
      if (first?.kind !== 'opened' || first.identity !== identity || JSON.stringify(first.caps) !== JSON.stringify(caps)) throw new Error('Frozen ledger identity/caps mismatch');
    } else this.append({ kind: 'opened', caps, identity });
    this.startedAt = this.events[0]!.at;
  }
  private append(event: Omit<LedgerEvent, 'sequence' | 'at'>): void {
    const entry: LedgerEvent = { ...event, sequence: this.events.length, at: Date.now() };
    const fd = openSync(this.path, 'a', 0o600);
    try { writeSync(fd, JSON.stringify(entry) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    this.events.push(entry);
  }
  get runs(): number { return this.events.filter((e) => e.kind === 'run').length; }
  get requests(): number { return this.events.filter((e) => e.kind === 'request').length; }
  get observedTokens(): number { return this.events.reduce((n, e) => n + (e.kind === 'usage' ? e.tokens ?? 0 : 0), 0); }
  get remainingMs(): number { return Math.max(0, this.startedAt + this.caps.timeoutMs - Date.now()); }
  hasRun(id: string): boolean { return this.events.some((e) => e.kind === 'run' && e.runId === id); }
  requestsFor(id: string): number { return this.events.filter((e) => e.kind === 'request' && e.runId === id).length; }
  reserveRun(runId: string): boolean {
    if (this.hasRun(runId)) throw new Error('Run already reserved; interrupted runs cannot be silently retried');
    if (this.runs >= this.caps.maxRuns || this.remainingMs <= 0 || this.requests >= this.caps.maxRequests || this.observedTokens >= this.caps.maxObservedTokens) return false;
    this.append({ kind: 'run', runId }); return true;
  }
  reserveRequest(runId: string): boolean {
    if (!this.hasRun(runId)) throw new Error('Request without a reserved run');
    if (this.requests >= this.caps.maxRequests || this.remainingMs <= 0 || this.observedTokens >= this.caps.maxObservedTokens) return false;
    this.append({ kind: 'request', runId }); return true;
  }
  usage(runId: string, tokens: number): void {
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('Invalid usage');
    this.append({ kind: 'usage', runId, tokens });
  }
  finish(runId: string): void { this.append({ kind: 'finished', runId }); }
  summary() {
    return { caps: this.caps, runsReserved: this.runs, requestsReserved: this.requests, observedTokens: this.observedTokens, remainingMs: this.remainingMs,
      policy: 'Tickets include unsuccessful authentication/dispatch; never refunded. Tokens are observed after responses; missing usage is unknown, not zero.' };
  }
}
