/**
 * Decision log: one JSON object per line (JSONL), each holding the request,
 * the full routing decision and the execution outcome.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogRecord } from './types.js';
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

const DECISION_STATUSES = ['routed', 'unroutable', 'rejected'];

/** Check the parts of a record the replay harness depends on. */
function parseRecord(raw: unknown, c: Checker, path: string): LogRecord | undefined {
  const obj = c.record(raw, path, ['schemaVersion', 'timestamp', 'request', 'decision', 'outcome']);
  if (!obj) return undefined;
  if (obj['schemaVersion'] !== 1) c.add(`${path}.schemaVersion`, 'must be 1');
  const timestamp = c.string(obj['timestamp'], `${path}.timestamp`);
  if (timestamp !== undefined && Number.isNaN(Date.parse(timestamp))) c.add(`${path}.timestamp`, 'is not a valid ISO timestamp');
  const request = parseRequest(c, obj['request'], `${path}.request`);

  const decision = c.record(obj['decision'], `${path}.decision`, [
    'schemaVersion', 'requestId', 'policy', 'appliedOverride', 'effectiveWeights', 'status', 'reason',
    'primary', 'fallbacks', 'context', 'candidates', 'ranking', 'budget',
  ]);
  if (decision) {
    c.oneOf(decision['status'], `${path}.decision.status`, DECISION_STATUSES);
    if (decision['primary'] !== null && typeof decision['primary'] !== 'string') c.add(`${path}.decision.primary`, 'must be a string or null');
    c.array(decision['ranking'], `${path}.decision.ranking`);
    const context = c.record(decision['context'], `${path}.decision.context`, ['openProviders', 'budget']);
    if (context) c.stringArray(context['openProviders'], `${path}.decision.context.openProviders`);
  }
  const outcome = c.record(obj['outcome'], `${path}.outcome`, ['status', 'servedBy', 'attempts', 'usage', 'actualCostUsd']);
  if (outcome) {
    c.oneOf(outcome['status'], `${path}.outcome.status`, ['success', 'failed', 'exhausted', 'not_executed']);
    if (outcome['actualCostUsd'] !== null) c.number(outcome['actualCostUsd'], `${path}.outcome.actualCostUsd`, { min: 0 });
  }
  // The rest of the decision and outcome is trusted as recorded; replay reads only the fields checked above.
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
