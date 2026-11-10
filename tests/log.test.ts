import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, Gateway, JsonlFileSink, ManualClock, MockProvider, parseLog, readLog } from '../src/index.js';
import { baselinePolicy, exampleCatalog, examplePath, makeRequest } from './helpers.js';

describe('decision log', () => {
  it('appends one JSON line per request and reads it back unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'routing-gateway-'));
    const file = join(dir, 'nested', 'decisions.jsonl');
    const catalog = exampleCatalog();
    const policy = baselinePolicy(catalog);
    const clock = new ManualClock(Date.UTC(2026, 0, 1));
    const gateway = new Gateway({
      catalog,
      policy,
      clock: clock.now,
      sink: new JsonlFileSink(file),
      providers: Object.fromEntries(['aurora', 'boreal', 'cirrus'].map((p) => [p, new MockProvider(p)])),
    });

    const written = [
      await gateway.handle(makeRequest({ id: 'one' })),
      await gateway.handle(makeRequest({ id: 'two', taskClass: 'classify' })),
    ];

    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ schemaVersion: 1, request: { id: 'one' }, decision: { status: 'routed' }, outcome: { status: 'success' } });
    expect(readLog(file)).toEqual(written);
  });

  it('ignores blank lines and names the offending line on errors', () => {
    expect(parseLog('\n\n')).toEqual([]);
    expect(() => parseLog('{"nope"', 'sample.jsonl')).toThrow(/sample\.jsonl line 1 is invalid[\s\S]*not valid JSON/);
    const bad = JSON.stringify({ schemaVersion: 1, timestamp: 'yesterday', request: { id: 'x' }, decision: {}, outcome: {} });
    expect(() => parseLog(`\n${bad}\n`, 'sample.jsonl')).toThrow(/sample\.jsonl line 2 is invalid[\s\S]*timestamp/);
  });

  it('reports unreadable files as a ConfigError', () => {
    expect(() => readLog(join(tmpdir(), 'does-not-exist-routing-gateway.jsonl'))).toThrow(ConfigError);
  });

  it('parses the bundled sample log', () => {
    expect(readLog(examplePath('requests.sample.jsonl')).length).toBeGreaterThanOrEqual(30);
  });
});
