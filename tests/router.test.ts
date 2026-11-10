import { describe, expect, it } from 'vitest';
import { routeRequest, estimateCostUsd, type EliminationCode, type RoutingDecision } from '../src/index.js';
import { baselinePolicy, exampleCatalog, makeCatalog, makeModel, makePolicy, makeRequest } from './helpers.js';

function codes(decision: RoutingDecision, route: string): EliminationCode[] {
  return decision.candidates.find((c) => c.route === route)?.eliminations.map((e) => e.code) ?? [];
}

describe('cost estimation', () => {
  it('prices input and output tokens per million', () => {
    const m = makeModel('aurora', 'a', { pricing: { inputPerMillionUsd: 2, outputPerMillionUsd: 10 } });
    expect(estimateCostUsd(m, 500_000, 100_000)).toBe(2);
    expect(estimateCostUsd(m, 0, 0)).toBe(0);
  });
});

describe('hard constraints', () => {
  const catalog = makeCatalog(
    makeModel('aurora', 'plain'),
    makeModel('aurora', 'seer', { capabilities: { tools: true, vision: true, jsonOutput: true, maxContextTokens: 100_000 } }),
    makeModel('boreal', 'tiny', { capabilities: { tools: false, vision: false, jsonOutput: false, maxContextTokens: 1500 }, latencyClass: 'fast', regions: ['apac'], qualityTier: 1 }),
    makeModel('cirrus', 'slowpoke', { latencyClass: 'slow', pricing: { inputPerMillionUsd: 100, outputPerMillionUsd: 100 } }),
  );

  it('flags each failing constraint with its reason code', () => {
    const request = makeRequest({
      requiredCapabilities: ['vision'],
      estimatedInputTokens: 2000,
      requiredRegion: 'eu',
      maxLatencyClass: 'standard',
      maxCostUsd: 0.01,
    });
    const policy = makePolicy({ taskOverrides: { general: { minQualityTier: 2 } } });
    const d = routeRequest(request, policy, catalog);
    expect(codes(d, 'aurora/plain')).toEqual(['MISSING_CAPABILITY']);
    expect(codes(d, 'boreal/tiny')).toEqual(
      expect.arrayContaining(['MISSING_CAPABILITY', 'CONTEXT_EXCEEDED', 'REGION_MISMATCH', 'QUALITY_BELOW_MINIMUM']),
    );
    expect(codes(d, 'cirrus/slowpoke')).toEqual(expect.arrayContaining(['MISSING_CAPABILITY', 'LATENCY_EXCEEDS_LIMIT', 'COST_EXCEEDS_LIMIT']));
    expect(d.primary).toBe('aurora/seer');
    expect(d.candidates.find((c) => c.route === 'aurora/seer')?.eligible).toBe(true);
  });

  it('applies deny rules by provider, model, tenant and task class (all fields must match)', () => {
    const policy = makePolicy({
      deny: [
        { id: 'no-boreal-for-a', reason: 'test', match: { provider: 'boreal', tenantId: 'tenant-a' } },
        { id: 'no-plain-for-chat', reason: 'test', match: { model: 'plain', taskClass: 'chat' } },
      ],
    });
    const d1 = routeRequest(makeRequest({ tenantId: 'tenant-a', taskClass: 'chat' }), policy, catalog);
    expect(codes(d1, 'boreal/tiny')).toContain('DENY_RULE');
    expect(codes(d1, 'aurora/plain')).toContain('DENY_RULE');
    const d2 = routeRequest(makeRequest({ tenantId: 'tenant-b', taskClass: 'other' }), policy, catalog);
    expect(codes(d2, 'boreal/tiny')).not.toContain('DENY_RULE');
    expect(codes(d2, 'aurora/plain')).not.toContain('DENY_RULE');
    expect(d1.candidates.find((c) => c.route === 'boreal/tiny')?.eliminations[0]?.detail).toContain('no-boreal-for-a');
  });

  it('honours task-class provider allow lists', () => {
    const policy = makePolicy({ taskOverrides: { general: { allowProviders: ['cirrus'] } } });
    const d = routeRequest(makeRequest(), policy, catalog);
    expect(codes(d, 'aurora/plain')).toContain('PROVIDER_NOT_ALLOWED');
    expect(d.primary).toBe('cirrus/slowpoke');
    expect(d.appliedOverride).toBe('general');
  });

  it('marks open circuits as eliminations and records them in the context', () => {
    const d = routeRequest(makeRequest(), makePolicy(), catalog, { openProviders: ['cirrus', 'aurora', 'aurora'] });
    expect(codes(d, 'aurora/plain')).toContain('CIRCUIT_OPEN');
    expect(codes(d, 'cirrus/slowpoke')).toContain('CIRCUIT_OPEN');
    expect(d.context.openProviders).toEqual(['aurora', 'cirrus']);
    expect(d.primary).toBe('boreal/tiny');
  });

  it('returns an unroutable decision with machine-readable reasons when nothing survives', () => {
    const d = routeRequest(makeRequest({ requiredRegion: 'mars' }), makePolicy(), catalog);
    expect(d.status).toBe('unroutable');
    expect(d.primary).toBeNull();
    expect(d.fallbacks).toEqual([]);
    expect(d.ranking).toEqual([]);
    expect(d.reason?.code).toBe('NO_ELIGIBLE_CANDIDATE');
    expect(d.candidates.every((c) => !c.eligible && codes(d, c.route).includes('REGION_MISMATCH'))).toBe(true);
  });
});

describe('ranking', () => {
  it('ranks by weighted cost/quality/latency and explains the components', () => {
    const catalog = makeCatalog(
      makeModel('aurora', 'cheap', { pricing: { inputPerMillionUsd: 100, outputPerMillionUsd: 100 }, qualityTier: 1, latencyClass: 'fast' }),
      makeModel('aurora', 'best', { pricing: { inputPerMillionUsd: 1100, outputPerMillionUsd: 1100 }, qualityTier: 5, latencyClass: 'slow' }),
    );
    const request = makeRequest({ estimatedInputTokens: 10_000, estimatedOutputTokens: 0 });

    const costFirst = routeRequest(request, makePolicy({ weights: { cost: 1, quality: 0, latency: 0 } }), catalog);
    expect(costFirst.primary).toBe('aurora/cheap');
    expect(costFirst.ranking[0]).toMatchObject({ rank: 1, score: 1, components: { cost: 1, quality: 0, latency: 1 } });
    expect(costFirst.ranking[1]).toMatchObject({ rank: 2, score: 0, components: { cost: 0, quality: 1, latency: 0 } });

    const qualityFirst = routeRequest(request, makePolicy({ weights: { cost: 0, quality: 1, latency: 0 } }), catalog);
    expect(qualityFirst.primary).toBe('aurora/best');
  });

  it('applies per-task-class weight overrides', () => {
    const catalog = makeCatalog(
      makeModel('aurora', 'cheap', { pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 1 }, qualityTier: 1 }),
      makeModel('aurora', 'best', { pricing: { inputPerMillionUsd: 11, outputPerMillionUsd: 11 }, qualityTier: 5 }),
    );
    const policy = makePolicy({
      weights: { cost: 1, quality: 0, latency: 0 },
      taskOverrides: { reasoning: { weights: { cost: 0, quality: 1, latency: 0 } } },
    });
    expect(routeRequest(makeRequest({ taskClass: 'chat' }), policy, catalog).primary).toBe('aurora/cheap');
    const reasoning = routeRequest(makeRequest({ taskClass: 'reasoning' }), policy, catalog);
    expect(reasoning.primary).toBe('aurora/best');
    expect(reasoning.effectiveWeights).toEqual({ cost: 0, quality: 1, latency: 0 });
    expect(reasoning.appliedOverride).toBe('reasoning');
  });

  it('breaks exact ties deterministically: cost, then quality, then route id', () => {
    const same = { pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 1 }, qualityTier: 3 };
    const catalog = makeCatalog(makeModel('boreal', 'zeta', same), makeModel('aurora', 'alpha', same), makeModel('cirrus', 'mid', same));
    const forward = routeRequest(makeRequest(), makePolicy(), catalog);
    const reversed = routeRequest(makeRequest(), makePolicy(), makeCatalog(...[...catalog.models].reverse()));
    expect(forward.ranking.map((r) => r.route)).toEqual(['aurora/alpha', 'boreal/zeta', 'cirrus/mid']);
    expect(reversed).toEqual(forward);

    // Equal score but different cost: the cheaper route wins the tie.
    const t = makeCatalog(
      makeModel('aurora', 'pricey', { pricing: { inputPerMillionUsd: 3, outputPerMillionUsd: 3 }, qualityTier: 5 }),
      makeModel('boreal', 'thrifty', { pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 1 }, qualityTier: 1 }),
    );
    const tie = routeRequest(makeRequest(), makePolicy({ weights: { cost: 1, quality: 1, latency: 0 } }), t);
    expect(tie.ranking.map((r) => r.score)).toEqual([0.5, 0.5]);
    expect(tie.primary).toBe('boreal/thrifty');
  });

  it('is fully deterministic for identical inputs', () => {
    const catalog = exampleCatalog();
    const policy = baselinePolicy(catalog);
    const request = makeRequest({ taskClass: 'code-review', requiredCapabilities: ['tools'] });
    const a = JSON.stringify(routeRequest(request, policy, catalog));
    const b = JSON.stringify(routeRequest(structuredClone(request), structuredClone(policy), structuredClone(catalog)));
    expect(a).toBe(b);
  });
});

describe('fallback chain', () => {
  const catalog = makeCatalog(
    makeModel('aurora', 'a1', { qualityTier: 5 }),
    makeModel('aurora', 'a2', { qualityTier: 4 }),
    makeModel('boreal', 'b1', { qualityTier: 3 }),
    makeModel('cirrus', 'c1', { qualityTier: 2 }),
  );
  const weights = { cost: 0, quality: 1, latency: 0 };

  it('lists ranked fallbacks up to the configured depth', () => {
    const d = routeRequest(makeRequest(), makePolicy({ weights, fallbackDepth: 2 }), catalog);
    expect(d.primary).toBe('aurora/a1');
    expect(d.fallbacks).toEqual(['aurora/a2', 'boreal/b1']);
    expect(routeRequest(makeRequest(), makePolicy({ weights, fallbackDepth: 0 }), catalog).fallbacks).toEqual([]);
  });

  it('can require fallbacks from distinct providers', () => {
    const d = routeRequest(makeRequest(), makePolicy({ weights, fallbackDepth: 3, distinctProviderFallbacks: true }), catalog);
    expect(d.fallbacks).toEqual(['boreal/b1', 'cirrus/c1']);
  });

  it('lets a task class override the depth', () => {
    const policy = makePolicy({ weights, fallbackDepth: 1, taskOverrides: { general: { fallbackDepth: 3 } } });
    expect(routeRequest(makeRequest(), policy, catalog).fallbacks).toHaveLength(3);
  });
});

describe('budget gate', () => {
  const catalog = makeCatalog(
    makeModel('aurora', 'big', { pricing: { inputPerMillionUsd: 100, outputPerMillionUsd: 100 }, qualityTier: 5 }),
    makeModel('boreal', 'small', { pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 1 }, qualityTier: 2 }),
  );
  const weights = { cost: 0, quality: 1, latency: 0 };
  const request = makeRequest({ estimatedInputTokens: 10_000, estimatedOutputTokens: 0 }); // big = $1.00, small = $0.01
  const window = { windowStartMs: 0, windowEndMs: 1000 };

  it('passes requests that fit and records the budget view', () => {
    const policy = makePolicy({ weights, budget: { windowSeconds: 1, defaultLimitUsd: 5, tenantLimitsUsd: {}, onExceed: 'reject' } });
    const d = routeRequest(request, policy, catalog, { budget: { limitUsd: 5, spentUsd: 1, ...window } });
    expect(d.primary).toBe('aurora/big');
    expect(d.budget).toMatchObject({ outcome: 'within_budget', remainingUsd: 4, estimatedCostUsd: 1, downgradedFrom: null });
  });

  it('rejects when the policy says reject, and records why', () => {
    const policy = makePolicy({ weights, budget: { windowSeconds: 1, defaultLimitUsd: 5, tenantLimitsUsd: {}, onExceed: 'reject' } });
    const d = routeRequest(request, policy, catalog, { budget: { limitUsd: 5, spentUsd: 4.5, ...window } });
    expect(d.status).toBe('rejected');
    expect(d.primary).toBeNull();
    expect(d.reason?.code).toBe('BUDGET_EXCEEDED');
    expect(d.budget).toMatchObject({ outcome: 'rejected', remainingUsd: 0.5, excluded: [{ route: 'aurora/big', estimatedCostUsd: 1, code: 'EXCEEDS_REMAINING_BUDGET' }] });
  });

  it('downgrades to the best affordable route when the policy says downgrade', () => {
    const policy = makePolicy({ weights, budget: { windowSeconds: 1, defaultLimitUsd: 5, tenantLimitsUsd: {}, onExceed: 'downgrade' } });
    const d = routeRequest(request, policy, catalog, { budget: { limitUsd: 5, spentUsd: 4.5, ...window } });
    expect(d.status).toBe('routed');
    expect(d.primary).toBe('boreal/small');
    expect(d.fallbacks).toEqual([]);
    expect(d.budget).toMatchObject({ outcome: 'downgraded', downgradedFrom: 'aurora/big', excluded: [expect.objectContaining({ route: 'aurora/big' })] });
  });

  it('rejects a downgrade when nothing is affordable', () => {
    const policy = makePolicy({ weights, budget: { windowSeconds: 1, defaultLimitUsd: 5, tenantLimitsUsd: {}, onExceed: 'downgrade' } });
    const d = routeRequest(request, policy, catalog, { budget: { limitUsd: 5, spentUsd: 4.995, ...window } });
    expect(d.status).toBe('rejected');
    expect(d.reason?.message).toContain('no eligible route is affordable');
  });

  it('ignores budget context when the policy defines no budget', () => {
    const d = routeRequest(request, makePolicy({ weights }), catalog, { budget: { limitUsd: 0, spentUsd: 0, ...window } });
    expect(d.status).toBe('routed');
    expect(d.budget).toBeNull();
    expect(d.context.budget).toBeNull();
  });
});
