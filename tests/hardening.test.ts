import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BudgetTracker,
  ConfigError,
  Gateway,
  ManualClock,
  MockProvider,
  evaluateThresholds,
  formatReport,
  parseLog,
  replay,
  routeRequest,
  serializeRecords,
  validatePolicy,
  type LogRecord,
  type ProviderAdapter,
  type RoutingPolicy,
} from '../src/index.js';
import { runReplay } from '../src/cli/replay.js';
import { runRoute } from '../src/cli/route.js';
import { exampleCatalog, examplePath, makeCatalog, makeModel, makePolicy, makeRequest } from './helpers.js';

// Names that exist on Object.prototype (or are special on it). "__proto__" is not a valid
// identifier for the validators, but library callers can still pass it to the engine directly.
const HOSTILE = ['constructor', 'toString', 'valueOf', '__proto__'] as const;

const budgetPolicy = (extra: Partial<RoutingPolicy> = {}): RoutingPolicy =>
  makePolicy({
    weights: { cost: 0, quality: 1, latency: 0 },
    budget: { windowSeconds: 3600, defaultLimitUsd: 0.001, tenantLimitsUsd: {}, onExceed: 'reject' },
    ...extra,
  });

const catalog = makeCatalog(
  makeModel('aurora', 'big', { qualityTier: 5, pricing: { inputPerMillionUsd: 100, outputPerMillionUsd: 100 } }),
  makeModel('boreal', 'small', { qualityTier: 2, pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 1 } }),
);

describe('prototype-safe lookups (GW-1)', () => {
  for (const name of HOSTILE) {
    it(`enforces the default budget for a tenant named ${name}`, () => {
      const tracker = new BudgetTracker(budgetPolicy().budget ?? { windowSeconds: 1, defaultLimitUsd: 0, tenantLimitsUsd: {}, onExceed: 'reject' }, () => 0);
      expect(tracker.limitFor(name)).toBe(0.001);
      const snapshot = tracker.snapshot(name);
      expect(snapshot.limitUsd).toBe(0.001);
      expect(Number.isFinite(snapshot.limitUsd)).toBe(true);

      const request = makeRequest({ tenantId: name, estimatedInputTokens: 10_000, estimatedOutputTokens: 0 }); // big = $1, small = $0.01
      const decision = routeRequest(request, budgetPolicy(), catalog, { budget: snapshot });
      expect(decision.status).toBe('rejected');
      expect(decision.budget?.outcome).toBe('rejected');
      expect(Number.isNaN(decision.budget?.remainingUsd)).toBe(false);
    });

    it(`does not treat task class ${name} as an override`, () => {
      const decision = routeRequest(makeRequest({ taskClass: name }), makePolicy(), catalog);
      expect(decision.appliedOverride).toBeNull();
      expect(decision.effectiveWeights).toEqual({ cost: 1, quality: 1, latency: 1 });
      expect(decision.status).toBe('routed');
    });

    it(`handles a replay record whose task class is ${name}`, () => {
      const policy = makePolicy({ weights: { cost: 0, quality: 1, latency: 0 } });
      const request = makeRequest({ taskClass: name });
      const record: LogRecord = {
        schemaVersion: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        request,
        decision: routeRequest(request, policy, catalog),
        outcome: { status: 'success', servedBy: 'aurora/big', attempts: [], usage: null, actualCostUsd: 0.001 },
      };
      const report = replay([record], makePolicy({ name: 'cheap', weights: { cost: 1, quality: 0, latency: 0 } }), catalog);
      expect(Object.hasOwn(report.byTaskClass, name)).toBe(true);
      expect(report.byTaskClass[name]?.changedPrimary).toBe(1);
      expect(Object.keys(report.byTaskClass)).toEqual([name]);
      expect(report.totals.requests).toBe(1);
      expect(({} as Record<string, unknown>)['requests']).toBeUndefined(); // no global pollution
      expect(Object.hasOwn(Object.prototype, 'requests')).toBe(false);
    });
  }

  it('applies per-tenant limits and per-task overrides that use prototype-like names', () => {
    const policy = validatePolicy({
      schemaVersion: 1,
      name: 'proto-names',
      weights: { cost: 0, quality: 1, latency: 0 },
      fallbackDepth: 0,
      taskOverrides: { constructor: { weights: { cost: 1, quality: 0, latency: 0 } }, toString: { minQualityTier: 5 } },
      budget: { windowSeconds: 60, defaultLimitUsd: 5, tenantLimitsUsd: { valueOf: 0.5, constructor: 0.002 }, onExceed: 'reject' },
    });
    const tracker = new BudgetTracker(policy.budget ?? { windowSeconds: 1, defaultLimitUsd: 0, tenantLimitsUsd: {}, onExceed: 'reject' }, () => 0);
    expect(tracker.limitFor('constructor')).toBe(0.002);
    expect(tracker.limitFor('valueOf')).toBe(0.5);
    expect(tracker.limitFor('toString')).toBe(5);

    expect(routeRequest(makeRequest({ taskClass: 'constructor' }), policy, catalog).primary).toBe('boreal/small'); // cost-first override
    expect(routeRequest(makeRequest({ taskClass: 'toString' }), policy, catalog).primary).toBe('aurora/big'); // tier-5 floor
    expect(routeRequest(makeRequest({ taskClass: 'valueOf' }), policy, catalog).appliedOverride).toBeNull();
  });

  it('rejects __proto__ as a tenant or task-class name instead of silently dropping it', () => {
    const text =
      '{"schemaVersion":1,"name":"p","weights":{"cost":1,"quality":1,"latency":1},"fallbackDepth":0,' +
      '"taskOverrides":{"__proto__":{"minQualityTier":5}},' +
      '"budget":{"windowSeconds":60,"defaultLimitUsd":1,"tenantLimitsUsd":{"__proto__":0},"onExceed":"reject"}}';
    let issues: readonly string[] = [];
    try {
      validatePolicy(JSON.parse(text));
    } catch (error) {
      if (error instanceof ConfigError) issues = error.issues;
    }
    expect(issues.some((i) => i.includes('taskOverrides') && i.includes('not valid'))).toBe(true);
    expect(issues.some((i) => i.includes('tenantLimitsUsd') && i.includes('not valid'))).toBe(true);
  });

  it('enforces the budget end to end for a tenant named constructor', async () => {
    const gateway = new Gateway({
      catalog,
      policy: budgetPolicy(),
      providers: { aurora: new MockProvider('aurora'), boreal: new MockProvider('boreal') },
      clock: new ManualClock().now,
    });
    const rec = await gateway.handle(makeRequest({ tenantId: 'constructor', estimatedInputTokens: 10_000, estimatedOutputTokens: 0 }));
    expect(rec.decision.status).toBe('rejected');
    expect(rec.outcome.status).toBe('not_executed');
  });

  it('treats a catalog provider named like a prototype member as "no adapter", not a crash', async () => {
    const odd = makeCatalog(makeModel('constructor', 'm1', { qualityTier: 5 }), makeModel('boreal', 'small', { qualityTier: 2 }));
    const gateway = new Gateway({
      catalog: odd,
      policy: makePolicy({ weights: { cost: 0, quality: 1, latency: 0 }, fallbackDepth: 1 }),
      providers: { boreal: new MockProvider('boreal') },
      clock: new ManualClock().now,
    });
    const rec = await gateway.handle(makeRequest());
    expect(rec.outcome.attempts[0]).toMatchObject({ route: 'constructor/m1', status: 'skipped', skipReason: 'NO_ADAPTER' });
    expect(rec.outcome.servedBy).toBe('boreal/small');
  });
});

describe('fallbacks respect the budget', () => {
  const three = makeCatalog(
    makeModel('aurora', 'a1', { qualityTier: 5, pricing: { inputPerMillionUsd: 100, outputPerMillionUsd: 0 } }), // $1.00
    makeModel('boreal', 'b1', { qualityTier: 4, pricing: { inputPerMillionUsd: 300, outputPerMillionUsd: 0 } }), // $3.00
    makeModel('cirrus', 'c1', { qualityTier: 3, pricing: { inputPerMillionUsd: 10, outputPerMillionUsd: 0 } }), // $0.10
  );
  const request = makeRequest({ estimatedInputTokens: 10_000, estimatedOutputTokens: 0 });
  const policy = makePolicy({
    weights: { cost: 0, quality: 1, latency: 0 },
    fallbackDepth: 2,
    budget: { windowSeconds: 1, defaultLimitUsd: 2, tenantLimitsUsd: {}, onExceed: 'reject' },
  });

  it('keeps an over-budget model out of the chain and records why', () => {
    const d = routeRequest(request, policy, three, { budget: { limitUsd: 2, spentUsd: 0, windowStartMs: 0, windowEndMs: 1000 } });
    expect(d.budget?.outcome).toBe('within_budget'); // the primary fits
    expect(d.primary).toBe('aurora/a1');
    expect(d.fallbacks).toEqual(['cirrus/c1']); // boreal/b1 ($3.00 > $2.00 remaining) is not offered as a fallback
    expect(d.budget?.excluded).toEqual([{ route: 'boreal/b1', estimatedCostUsd: 3, code: 'EXCEEDS_REMAINING_BUDGET' }]);
  });

  it('never executes a fallback the budget excluded', async () => {
    const providers = { aurora: new MockProvider('aurora', () => ({ kind: 'error', code: 'DOWN', retryable: true })), boreal: new MockProvider('boreal'), cirrus: new MockProvider('cirrus') };
    const gateway = new Gateway({ catalog: three, policy, providers, clock: new ManualClock().now });
    const rec = await gateway.handle({ ...request, tenantId: 'tenant-a' });
    expect(rec.outcome.servedBy).toBe('cirrus/c1');
    expect(providers.boreal.calls).toHaveLength(0);
  });

  it('leaves the chain alone when there is no budget section', () => {
    const d = routeRequest(request, makePolicy({ weights: { cost: 0, quality: 1, latency: 0 }, fallbackDepth: 2 }), three);
    expect(d.fallbacks).toEqual(['boreal/b1', 'cirrus/c1']);
    expect(d.budget).toBeNull();
  });
});

describe('timeout timer hygiene (GW-2)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const gatewayWith = (adapter: ProviderAdapter) =>
    new Gateway({
      catalog: makeCatalog(makeModel('aurora', 'a1')),
      policy: makePolicy({ fallbackDepth: 0 }),
      providers: { aurora: adapter },
      clock: new ManualClock().now,
      timeoutMs: 60_000,
    });

  it('clears the timer when the adapter throws synchronously', async () => {
    vi.useFakeTimers();
    const throwing: ProviderAdapter = {
      provider: 'aurora',
      invoke: () => {
        throw new Error('sync failure');
      },
    };
    const rec = await gatewayWith(throwing).handle(makeRequest());
    expect(rec.outcome.attempts[0]).toMatchObject({ status: 'error', errorCode: 'UNKNOWN' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timer after a success and after an asynchronous rejection', async () => {
    vi.useFakeTimers();
    await gatewayWith(new MockProvider('aurora')).handle(makeRequest());
    expect(vi.getTimerCount()).toBe(0);
    await gatewayWith(new MockProvider('aurora', () => ({ kind: 'error', code: 'DOWN', retryable: true }))).handle(makeRequest());
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('actual usage is charged, not the estimate', () => {
  it('records adapter-reported usage and charges the budget with it', async () => {
    const adapter: ProviderAdapter = {
      provider: 'aurora',
      invoke: (call) => Promise.resolve({ text: 'ok', inputTokens: call.inputTokens * 3, outputTokens: 0 }),
    };
    const single = makeCatalog(makeModel('aurora', 'a1', { pricing: { inputPerMillionUsd: 100, outputPerMillionUsd: 0 } }));
    const policy = makePolicy({ budget: { windowSeconds: 3600, defaultLimitUsd: 10, tenantLimitsUsd: {}, onExceed: 'reject' } });
    const gateway = new Gateway({ catalog: single, policy, providers: { aurora: adapter }, clock: new ManualClock().now });

    const rec = await gateway.handle(makeRequest({ estimatedInputTokens: 1000, estimatedOutputTokens: 100 }));
    expect(rec.decision.ranking[0]?.estimatedCostUsd).toBe(0.1); // 1000 tokens at $100 per million
    expect(rec.outcome.usage).toEqual({ inputTokens: 3000, outputTokens: 0 });
    expect(rec.outcome.actualCostUsd).toBe(0.3);
    expect(gateway.budget?.snapshot('tenant-a').spentUsd).toBe(0.3);
  });
});

describe('log validation is complete', () => {
  const goodRecord = async (): Promise<Record<string, unknown>> => {
    const gateway = new Gateway({
      catalog,
      policy: budgetPolicy({ budget: { windowSeconds: 3600, defaultLimitUsd: 10, tenantLimitsUsd: {}, onExceed: 'reject' } }),
      providers: { aurora: new MockProvider('aurora'), boreal: new MockProvider('boreal') },
      clock: new ManualClock(Date.UTC(2026, 0, 1)).now,
    });
    const rec = await gateway.handle(makeRequest());
    return JSON.parse(serializeRecords([rec])) as Record<string, unknown>;
  };

  const withMutation = async (mutate: (r: Record<string, Record<string, unknown>>) => void): Promise<string> => {
    const rec = (await goodRecord()) as Record<string, Record<string, unknown>>;
    mutate(rec);
    return JSON.stringify(rec);
  };

  it('accepts an unmodified record', async () => {
    expect(parseLog(await withMutation(() => undefined))).toHaveLength(1);
  });

  it('rejects ranking: [null] with a ConfigError that names the field and line', async () => {
    const line = await withMutation((r) => {
      (r['decision'] as Record<string, unknown>)['ranking'] = [null];
    });
    expect(() => parseLog(`\n${line}\n`, 'x.jsonl')).toThrow(ConfigError);
    expect(() => parseLog(`\n${line}\n`, 'x.jsonl')).toThrow(/x\.jsonl line 2 is invalid[\s\S]*decision\.ranking\[0\]: must be an object/);
  });

  it('rejects other malformed decision and outcome internals', async () => {
    const cases: Array<[string, (r: Record<string, Record<string, unknown>>) => void, RegExp]> = [
      ['candidates not an array', (r) => { r['decision']!['candidates'] = {}; }, /decision\.candidates: must be an array/],
      ['bad elimination code', (r) => { r['decision']!['candidates'] = [{ route: 'a/b', provider: 'a', model: 'b', estimatedCostUsd: 0, eligible: false, eliminations: [{ code: 'NOPE', detail: 'x' }] }]; }, /eliminations\[0\]\.code: must be one of/],
      ['routed without a primary', (r) => { r['decision']!['primary'] = null; }, /primary: must be set when status is "routed"/],
      ['primary missing from ranking', (r) => { r['decision']!['primary'] = 'ghost/model'; }, /is not in ranking/],
      ['negative cost', (r) => { r['outcome']!['actualCostUsd'] = -1; }, /actualCostUsd: must be >= 0/],
      ['attempt is not an object', (r) => { r['outcome']!['attempts'] = ['ok']; }, /attempts\[0\]: must be an object/],
      ['context missing', (r) => { delete r['decision']!['context']; }, /context: is required|context: must be an object/],
    ];
    for (const [label, mutate, pattern] of cases) {
      const line = await withMutation(mutate);
      expect(() => parseLog(line, 'case.jsonl'), label).toThrow(pattern);
    }
  });

  it('reports a truncated final line as an error naming the line (it does not skip it)', async () => {
    const line = await withMutation(() => undefined);
    const truncated = `${line}\n${line.slice(0, 40)}`;
    expect(() => parseLog(truncated, 'cut.jsonl')).toThrow(/cut\.jsonl line 2 is invalid[\s\S]*not valid JSON/);
  });

  it('makes the replay CLI exit 2 with a readable message instead of throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'routing-gateway-'));
    const file = join(dir, 'bad.jsonl');
    writeFileSync(file, await withMutation((r) => { (r['decision'] as Record<string, unknown>)['ranking'] = [null]; }), 'utf8');
    let err = '';
    const code = runReplay(['--log', file], { out: () => undefined, err: (t) => (err += t) });
    expect(code).toBe(2);
    expect(err).toContain('decision.ranking[0]');
  });
});

describe('replay accounting and gates (GW-3)', () => {
  const priced = makeCatalog(
    makeModel('aurora', 'free', { qualityTier: 1, pricing: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 } }),
    makeModel('boreal', 'paid', { qualityTier: 5, pricing: { inputPerMillionUsd: 10, outputPerMillionUsd: 10 } }),
  );
  const record = (): LogRecord => {
    const request = makeRequest();
    return {
      schemaVersion: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      request,
      decision: routeRequest(request, makePolicy({ weights: { cost: 1, quality: 0, latency: 0 } }), priced),
      outcome: { status: 'success', servedBy: 'aurora/free', attempts: [], usage: null, actualCostUsd: 0 },
    };
  };
  const qualityFirst = makePolicy({ name: 'quality-first', weights: { cost: 0, quality: 1, latency: 0 } });

  it('does not let --max-cost-increase-pct pass silently when the baseline cost is zero', () => {
    const report = replay([record()], qualityFirst, priced);
    expect(report.cost.baselineUsd).toBe(0);
    expect(report.cost.candidateUsd).toBeGreaterThan(0);
    expect(report.cost.deltaPct).toBeNull();
    const result = evaluateThresholds(report, { maxCostIncreasePct: 1000 });
    expect(result.passed).toBe(false);
    expect(result.violations[0]).toContain('zero baseline');
    expect(evaluateThresholds(report, { maxCostIncreaseUsd: 1 }).passed).toBe(true); // absolute limit still usable
    expect(formatReport(report, result, { maxCostIncreasePct: 1000 })).toContain('n/a, zero baseline');
  });

  it('reports 0% when a zero baseline stays at zero', () => {
    const same = replay([record()], makePolicy({ name: 'same', weights: { cost: 1, quality: 0, latency: 0 } }), priced);
    expect(same.cost.deltaPct).toBe(0);
    expect(evaluateThresholds(same, { maxCostIncreasePct: 0 }).passed).toBe(true);
  });

  it('keeps per-class and total counters consistent: unroutable requests are not "unchanged"', () => {
    const unroutable = makeRequest({ id: 'r-2', taskClass: 'general', requiredRegion: 'mars' });
    const stuck: LogRecord = { ...record(), request: unroutable, decision: routeRequest(unroutable, makePolicy(), priced) };
    const report = replay([record(), stuck], makePolicy({ name: 'same' }), priced);
    const summary = report.byTaskClass['general'];
    expect(report.totals).toMatchObject({ requests: 2, unchanged: 1, stillUnroutable: 1 });
    expect(summary).toMatchObject({ requests: 2, unchanged: 1, stillUnroutable: 1 });
    const sums = Object.values(report.byTaskClass).reduce((n, s) => n + s.unchanged, 0);
    expect(sums).toBe(report.totals.unchanged);
  });
});

describe('route CLI inputs', () => {
  const run = (argv: string[]) => {
    let out = '';
    let err = '';
    const code = runRoute(argv, { out: (t) => (out += t), err: (t) => (err += t) });
    return { code, out, err };
  };

  it('routes a request read from --request <file>', () => {
    const { code, out } = run(['--request', examplePath('sample-request.json')]);
    expect(code).toBe(0);
    expect(out).toContain('Request   demo-001');
    expect(out).toContain('Primary   cirrus/cirrus-flash');
  });

  it('reports a bad --request file as a validation error (exit 2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routing-gateway-'));
    const file = join(dir, 'req.json');
    writeFileSync(file, JSON.stringify({ id: 'x', tenantId: 't', taskClass: 'chat', estimatedInputTokens: -1, estimatedOutputTokens: 1 }), 'utf8');
    const { code, err } = run(['--request', file]);
    expect(code).toBe(2);
    expect(err).toContain('estimatedInputTokens');
  });

  it('rejects a negative --spent', () => {
    const { code, err } = run(['--spent=-1']);
    expect(code).toBe(2);
    expect(err).toContain('--spent must be >= 0');
  });

  it('still accepts --spent 0', () => {
    expect(run(['--spent', '0']).code).toBe(0);
  });

  it('uses the bundled catalog in a sanity check', () => {
    expect(exampleCatalog().models.length).toBe(8);
  });
});
