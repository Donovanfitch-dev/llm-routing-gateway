import { describe, expect, it } from 'vitest';
import { Gateway, ManualClock, MemorySink, MockProvider, type MockScript, type RoutingPolicy } from '../src/index.js';
import { makeCatalog, makeModel, makePolicy, makeRequest } from './helpers.js';

// Quality-only ranking gives a deterministic order: aurora/a1 > boreal/b1 > cirrus/c1.
const catalog = makeCatalog(
  makeModel('aurora', 'a1', { qualityTier: 5, pricing: { inputPerMillionUsd: 10, outputPerMillionUsd: 10 } }),
  makeModel('boreal', 'b1', { qualityTier: 4, pricing: { inputPerMillionUsd: 5, outputPerMillionUsd: 5 } }),
  makeModel('cirrus', 'c1', { qualityTier: 3, pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 1 } }),
);
const basePolicy = (extra: Partial<RoutingPolicy> = {}): RoutingPolicy =>
  makePolicy({
    weights: { cost: 0, quality: 1, latency: 0 },
    fallbackDepth: 2,
    distinctProviderFallbacks: true,
    breaker: { failureThreshold: 2, openDurationMs: 1000, halfOpenMaxProbes: 1 },
    ...extra,
  });

function setup(scripts: Partial<Record<'aurora' | 'boreal' | 'cirrus', MockScript>> = {}, policy = basePolicy()) {
  const clock = new ManualClock(Date.UTC(2026, 0, 1));
  const sink = new MemorySink();
  const providers = {
    aurora: new MockProvider('aurora', scripts.aurora),
    boreal: new MockProvider('boreal', scripts.boreal),
    cirrus: new MockProvider('cirrus', scripts.cirrus),
  };
  const gateway = new Gateway({ catalog, policy, providers, clock: clock.now, sink, timeoutMs: 25 });
  return { clock, sink, providers, gateway };
}

const unavailable: MockScript = () => ({ kind: 'error', code: 'UNAVAILABLE', retryable: true });
const request = makeRequest({ estimatedInputTokens: 1000, estimatedOutputTokens: 1000 });

describe('execution with fallback', () => {
  it('serves from the primary and records usage and actual cost', async () => {
    const { gateway, providers } = setup();
    const rec = await gateway.handle(request);
    expect(rec.decision.primary).toBe('aurora/a1');
    expect(rec.outcome).toMatchObject({ status: 'success', servedBy: 'aurora/a1', usage: { inputTokens: 1000, outputTokens: 1000 }, actualCostUsd: 0.02 });
    expect(rec.outcome.attempts).toHaveLength(1);
    expect(providers.boreal.calls).toHaveLength(0);
    expect(rec.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('moves down the chain on a retryable error', async () => {
    const { gateway } = setup({ aurora: unavailable });
    const rec = await gateway.handle(request);
    expect(rec.outcome.status).toBe('success');
    expect(rec.outcome.servedBy).toBe('boreal/b1');
    expect(rec.outcome.attempts.map((a) => [a.route, a.status, a.errorCode])).toEqual([
      ['aurora/a1', 'error', 'UNAVAILABLE'],
      ['boreal/b1', 'ok', null],
    ]);
  });

  it('treats a timeout as retryable', async () => {
    const { gateway } = setup({ aurora: () => ({ kind: 'hang' }), boreal: () => ({ kind: 'hang' }) });
    const rec = await gateway.handle(request);
    expect(rec.outcome.servedBy).toBe('cirrus/c1');
    expect(rec.outcome.attempts.map((a) => a.status)).toEqual(['timeout', 'timeout', 'ok']);
    expect(rec.outcome.attempts[0]).toMatchObject({ errorCode: 'TIMEOUT', retryable: true });
  });

  it('stops at a non-retryable error without trying fallbacks', async () => {
    const { gateway, providers } = setup({ aurora: () => ({ kind: 'error', code: 'INVALID_REQUEST', retryable: false }) });
    const rec = await gateway.handle(request);
    expect(rec.outcome).toMatchObject({ status: 'failed', servedBy: null, actualCostUsd: null });
    expect(rec.outcome.attempts).toHaveLength(1);
    expect(providers.boreal.calls).toHaveLength(0);
  });

  it('does not let non-retryable errors trip the circuit breaker', async () => {
    const { gateway } = setup({ aurora: () => ({ kind: 'error', code: 'INVALID_REQUEST', retryable: false }) });
    for (let i = 0; i < 5; i++) await gateway.handle(request);
    expect(gateway.breakers.get('aurora').state).toBe('closed');
  });

  it('reports exhaustion when every route fails', async () => {
    const { gateway } = setup({ aurora: unavailable, boreal: unavailable, cirrus: unavailable });
    const rec = await gateway.handle(request);
    expect(rec.outcome.status).toBe('exhausted');
    expect(rec.outcome.attempts).toHaveLength(3);
  });

  it('treats an unexpected thrown error as non-retryable', async () => {
    const { gateway } = setup({
      aurora: () => {
        throw new Error('boom');
      },
    });
    const rec = await gateway.handle(request);
    expect(rec.outcome.status).toBe('failed');
    expect(rec.outcome.attempts[0]).toMatchObject({ errorCode: 'UNKNOWN', retryable: false });
  });

  it('skips routes with no registered adapter', async () => {
    const clock = new ManualClock();
    const gateway = new Gateway({ catalog, policy: basePolicy(), providers: { boreal: new MockProvider('boreal') }, clock: clock.now });
    const rec = await gateway.handle(request);
    expect(rec.outcome.attempts[0]).toMatchObject({ route: 'aurora/a1', status: 'skipped', skipReason: 'NO_ADAPTER' });
    expect(rec.outcome.servedBy).toBe('boreal/b1');
  });
});

describe('circuit breaker integration', () => {
  it('opens after repeated failures, records the skip in the decision, then recovers via a half-open probe', async () => {
    let outage = true;
    const { gateway, providers, clock } = setup({ aurora: () => (outage ? { kind: 'error', code: 'UNAVAILABLE', retryable: true } : { kind: 'ok' }) });

    await gateway.handle(request);
    await gateway.handle(request);
    expect(gateway.breakers.get('aurora').state).toBe('open');
    expect(providers.aurora.calls).toHaveLength(2);

    const during = await gateway.handle(request);
    expect(during.decision.context.openProviders).toEqual(['aurora']);
    expect(during.decision.candidates.find((c) => c.route === 'aurora/a1')?.eliminations.map((e) => e.code)).toContain('CIRCUIT_OPEN');
    expect(during.decision.primary).toBe('boreal/b1');
    expect(providers.aurora.calls).toHaveLength(2); // not contacted while open

    outage = false;
    clock.advance(1000);
    const probe = await gateway.handle(request);
    expect(probe.decision.context.openProviders).toEqual([]);
    expect(probe.outcome.servedBy).toBe('aurora/a1');
    expect(gateway.breakers.get('aurora').state).toBe('closed');
  });

  it('records an attempt-level skip when a half-open breaker has no probe slot left', async () => {
    const { gateway, clock, providers } = setup();
    const breaker = gateway.breakers.get('aurora');
    breaker.recordFailure();
    breaker.recordFailure();
    clock.advance(1000);
    expect(breaker.allowRequest()).toBe(true); // another in-flight request holds the only probe slot

    const rec = await gateway.handle(request);
    expect(rec.decision.primary).toBe('aurora/a1'); // half-open is not "open" for routing purposes
    expect(rec.outcome.attempts[0]).toMatchObject({ route: 'aurora/a1', status: 'skipped', skipReason: 'CIRCUIT_OPEN' });
    expect(rec.outcome.servedBy).toBe('boreal/b1');
    expect(providers.aurora.calls).toHaveLength(0);
  });
});

describe('budgets and logging', () => {
  it('charges actual cost and downgrades once the tenant window is nearly spent', async () => {
    const policy = basePolicy({ budget: { windowSeconds: 3600, defaultLimitUsd: 0.03, tenantLimitsUsd: {}, onExceed: 'downgrade' } });
    const { gateway } = setup({}, policy);
    const first = await gateway.handle(request); // a1 costs $0.02
    expect(first.decision.budget?.outcome).toBe('within_budget');
    const second = await gateway.handle(request); // $0.02 > $0.01 remaining -> best affordable is b1 ($0.01)
    expect(second.decision.budget).toMatchObject({ outcome: 'downgraded', downgradedFrom: 'aurora/a1', excludedRoutes: ['aurora/a1'] });
    expect(second.outcome.servedBy).toBe('boreal/b1');
    expect(gateway.budget?.snapshot('tenant-a').spentUsd).toBe(0.03);
    const third = await gateway.handle(request); // window exhausted: nothing is affordable
    expect(third.decision.status).toBe('rejected');
  });

  it('does not execute rejected or unroutable requests', async () => {
    const policy = basePolicy({ budget: { windowSeconds: 3600, defaultLimitUsd: 0.001, tenantLimitsUsd: {}, onExceed: 'reject' } });
    const { gateway, providers } = setup({}, policy);
    const rejected = await gateway.handle(request);
    expect(rejected.decision.status).toBe('rejected');
    expect(rejected.outcome).toMatchObject({ status: 'not_executed', attempts: [] });

    const unroutable = await gateway.handle(makeRequest({ id: 'r-2', requiredRegion: 'mars' }));
    expect(unroutable.decision.status).toBe('unroutable');
    expect(unroutable.outcome.status).toBe('not_executed');
    expect(Object.values(providers).every((p) => p.calls.length === 0)).toBe(true);
  });

  it('writes one record per request to the sink', async () => {
    const { gateway, sink } = setup();
    await gateway.handle(request);
    await gateway.handle(makeRequest({ id: 'r-2' }));
    expect(sink.records.map((r) => r.request.id)).toEqual(['r-1', 'r-2']);
  });
});
