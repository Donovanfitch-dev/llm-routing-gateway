/**
 * Decision log: one JSON object per line (JSONL), each holding the request,
 * the full routing decision and the execution outcome.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ELIMINATION_CODES, type LogRecord } from './types.js';
import { ConfigError, Checker, parseRequest } from './validate.js';

export interface LogSink {
  write(record: LogRecord): void;
}

export class MemorySink implements LogSink {
  readonly records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }
}

export class JsonlFileSink implements LogSink {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(record: LogRecord): void {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8');
  }
}

export function serializeRecords(records: readonly LogRecord[]): string {
  return records.map((r) => `${JSON.stringify(r)}\n`).join('');
}

const DECISION_STATUSES = ['routed', 'unroutable', 'rejected'] as const;
const OUTCOME_STATUSES = ['success', 'failed', 'exhausted', 'not_executed'] as const;
const ATTEMPT_STATUSES = ['ok', 'error', 'timeout', 'skipped'] as const;
const SKIP_REASONS = ['CIRCUIT_OPEN', 'NO_ADAPTER'] as const;
const BUDGET_OUTCOMES = ['within_budget', 'downgraded', 'rejected'] as const;
const REASON_CODES = ['NO_ELIGIBLE_CANDIDATE', 'BUDGET_EXCEEDED'] as const;

const MONEY = { min: 0 };

function nullableString(c: Checker, value: unknown, path: string): string | null {
  return value === null ? null : (c.string(value, path) ?? null);
}

function checkWeights(c: Checker, value: unknown, path: string): void {
  const obj = c.record(value, path, ['cost', 'quality', 'latency']);
  if (!obj) return;
  for (const key of ['cost', 'quality', 'latency']) c.number(obj[key], `${path}.${key}`, MONEY);
}

function checkSnapshot(c: Checker, value: unknown, path: string): void {
  const obj = c.record(value, path, ['limitUsd', 'spentUsd', 'windowStartMs', 'windowEndMs']);
  if (!obj) return;
  for (const key of ['limitUsd', 'spentUsd', 'windowStartMs', 'windowEndMs']) c.number(obj[key], `${path}.${key}`, MONEY);
}

function eachItem(c: Checker, value: unknown, path: string, check: (item: unknown, itemPath: string) => void): void {
  const list = c.array(value, path);
  list?.forEach((item, i) => {
    check(item, `${path}[${i}]`);
  });
}

function checkDecision(c: Checker, raw: unknown, path: string): void {
  const d = c.record(raw, path, [
    'schemaVersion', 'requestId', 'policy', 'appliedOverride', 'effectiveWeights', 'status', 'reason',
    'primary', 'fallbacks', 'context', 'candidates', 'ranking', 'budget',
  ]);
  if (!d) return;
  if (d['schemaVersion'] !== 1) c.add(`${path}.schemaVersion`, 'must be 1');
  c.string(d['requestId'], `${path}.requestId`);
  c.string(d['policy'], `${path}.policy`);
  nullableString(c, d['appliedOverride'], `${path}.appliedOverride`);
  checkWeights(c, d['effectiveWeights'], `${path}.effectiveWeights`);
  const status = c.oneOf(d['status'], `${path}.status`, DECISION_STATUSES);
  if (d['reason'] !== null) {
    const reason = c.record(d['reason'], `${path}.reason`, ['code', 'message']);
    if (reason) {
      c.oneOf(reason['code'], `${path}.reason.code`, REASON_CODES);
      c.string(reason['message'], `${path}.reason.message`);
    }
  }
  const primary = nullableString(c, d['primary'], `${path}.primary`);
  c.stringArray(d['fallbacks'], `${path}.fallbacks`);

  const context = c.record(d['context'], `${path}.context`, ['openProviders', 'budget']);
  if (context) {
    c.stringArray(context['openProviders'], `${path}.context.openProviders`);
    if (context['budget'] !== null) checkSnapshot(c, context['budget'], `${path}.context.budget`);
  }

  eachItem(c, d['candidates'], `${path}.candidates`, (item, p) => {
    const cand = c.record(item, p, ['route', 'provider', 'model', 'estimatedCostUsd', 'eligible', 'eliminations']);
    if (!cand) return;
    c.string(cand['route'], `${p}.route`);
    c.string(cand['provider'], `${p}.provider`);
    c.string(cand['model'], `${p}.model`);
    c.number(cand['estimatedCostUsd'], `${p}.estimatedCostUsd`, MONEY);
    c.boolean(cand['eligible'], `${p}.eligible`);
    eachItem(c, cand['eliminations'], `${p}.eliminations`, (e, ep) => {
      const elim = c.record(e, ep, ['code', 'detail']);
      if (!elim) return;
      c.oneOf(elim['code'], `${ep}.code`, ELIMINATION_CODES);
      c.string(elim['detail'], `${ep}.detail`);
    });
  });

  const rankedRoutes: string[] = [];
  eachItem(c, d['ranking'], `${path}.ranking`, (item, p) => {
    const r = c.record(item, p, ['rank', 'route', 'score', 'components', 'estimatedCostUsd']);
    if (!r) return;
    c.number(r['rank'], `${p}.rank`, { integer: true, min: 1 });
    const route = c.string(r['route'], `${p}.route`);
    if (route !== undefined) rankedRoutes.push(route);
    c.number(r['score'], `${p}.score`, { min: 0, max: 1 });
    checkWeights(c, r['components'], `${p}.components`);
    c.number(r['estimatedCostUsd'], `${p}.estimatedCostUsd`, MONEY);
  });

  if (d['budget'] !== null) {
    const b = c.record(d['budget'], `${path}.budget`, ['outcome', 'limitUsd', 'spentUsd', 'remainingUsd', 'estimatedCostUsd', 'downgradedFrom', 'excluded']);
    if (b) {
      c.oneOf(b['outcome'], `${path}.budget.outcome`, BUDGET_OUTCOMES);
      for (const key of ['limitUsd', 'spentUsd', 'remainingUsd', 'estimatedCostUsd']) c.number(b[key], `${path}.budget.${key}`, MONEY);
      nullableString(c, b['downgradedFrom'], `${path}.budget.downgradedFrom`);
      eachItem(c, b['excluded'], `${path}.budget.excluded`, (item, p) => {
        const x = c.record(item, p, ['route', 'estimatedCostUsd', 'code']);
        if (!x) return;
        c.string(x['route'], `${p}.route`);
        c.number(x['estimatedCostUsd'], `${p}.estimatedCostUsd`, MONEY);
        c.oneOf(x['code'], `${p}.code`, ['EXCEEDS_REMAINING_BUDGET'] as const);
      });
    }
  }

  // Cross-field consistency that replay relies on.
  if (status === 'routed') {
    if (primary === null) c.add(`${path}.primary`, 'must be set when status is "routed"');
    else if (!rankedRoutes.includes(primary)) c.add(`${path}.primary`, `${JSON.stringify(primary)} is not in ranking`);
  } else if (status !== undefined && primary !== null) {
    c.add(`${path}.primary`, `must be null when status is "${status}"`);
  }
}

function checkOutcome(c: Checker, raw: unknown, path: string): void {
  const o = c.record(raw, path, ['status', 'servedBy', 'attempts', 'usage', 'actualCostUsd']);
  if (!o) return;
  c.oneOf(o['status'], `${path}.status`, OUTCOME_STATUSES);
  nullableString(c, o['servedBy'], `${path}.servedBy`);
  eachItem(c, o['attempts'], `${path}.attempts`, (item, p) => {
    const a = c.record(item, p, ['route', 'status', 'errorCode', 'retryable', 'skipReason']);
    if (!a) return;
    c.string(a['route'], `${p}.route`);
    c.oneOf(a['status'], `${p}.status`, ATTEMPT_STATUSES);
    nullableString(c, a['errorCode'], `${p}.errorCode`);
    if (a['retryable'] !== null) c.boolean(a['retryable'], `${p}.retryable`);
    if (a['skipReason'] !== null) c.oneOf(a['skipReason'], `${p}.skipReason`, SKIP_REASONS);
  });
  if (o['usage'] !== null) {
    const u = c.record(o['usage'], `${path}.usage`, ['inputTokens', 'outputTokens']);
    if (u) {
      c.number(u['inputTokens'], `${path}.usage.inputTokens`, { integer: true, min: 0 });
      c.number(u['outputTokens'], `${path}.usage.outputTokens`, { integer: true, min: 0 });
    }
  }
  if (o['actualCostUsd'] !== null) c.number(o['actualCostUsd'], `${path}.actualCostUsd`, MONEY);
}

/** Validate one log record completely, so replay never meets a malformed shape. */
function parseRecord(raw: unknown, c: Checker, path: string): LogRecord | undefined {
  const obj = c.record(raw, path, ['schemaVersion', 'timestamp', 'request', 'decision', 'outcome']);
  if (!obj) return undefined;
  if (obj['schemaVersion'] !== 1) c.add(`${path}.schemaVersion`, 'must be 1');
  const timestamp = c.string(obj['timestamp'], `${path}.timestamp`);
  if (timestamp !== undefined && Number.isNaN(Date.parse(timestamp))) c.add(`${path}.timestamp`, 'is not a valid ISO timestamp');
  const request = parseRequest(c, obj['request'], `${path}.request`);
  checkDecision(c, obj['decision'], `${path}.decision`);
  checkOutcome(c, obj['outcome'], `${path}.outcome`);
  return request && timestamp !== undefined ? (obj as unknown as LogRecord) : undefined;
}

/** Parse JSONL text. Errors name the 1-based line number. Blank lines are ignored. */
export function parseLog(text: string, source = 'log'): LogRecord[] {
  const records: LogRecord[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    const lineNo = index + 1;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`${source} line ${lineNo}`, [`not valid JSON: ${message}`]);
    }
    const c = new Checker();
    const record = parseRecord(raw, c, '$');
    if (c.issues.length > 0 || !record) throw new ConfigError(`${source} line ${lineNo}`, c.issues);
    records.push(record);
  });
  return records;
}

export function readLog(path: string): LogRecord[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Log file ${path}`, [`cannot be read: ${message}`]);
  }
  return parseLog(text, path);
}
