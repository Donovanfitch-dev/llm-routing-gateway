import { describe, expect, it } from 'vitest';
import { routeRequest, type ModelEntry } from '../src/index.js';
import { makeCatalog, makeModel, makePolicy, makeRequest } from './helpers.js';

// Regression tests for the documented ranking order (src/router.ts):
// higher score, then cheaper, then higher quality tier, then route id in
// plain code-unit order. Each test isolates one key by holding every key
// before it equal, and arranges catalog order against the expected result.
//
// Note on the final route-id key: rank() receives candidates already sorted
// by route id and Array.prototype.sort is stable, so deleting only the
// comparator's route-id clause is not observable through routeRequest. These
// tests pin the observable contract instead: fully tied routes come out in
// route-id order whatever order the catalog lists them in.

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

const TIED = { pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 1 }, qualityTier: 3, latencyClass: 'standard' as const };

describe('ranking tie-breaks', () => {
  it('breaks an equal score and equal cost by the higher quality tier, before route id', () => {
    // weights 1/1/1, identical pricing (cost component 1 for both):
    //   aurora/steady  tier 3 standard -> (1 + 0.5 + 0.5) / 3
    //   boreal/deep    tier 5 slow     -> (1 + 1   + 0  ) / 3
    // Route-id order alone would put aurora/steady first.
    const price = { pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 1 } };
    const catalog = makeCatalog(
      makeModel('aurora', 'steady', { ...price, qualityTier: 3, latencyClass: 'standard' }),
      makeModel('boreal', 'deep', { ...price, qualityTier: 5, latencyClass: 'slow' }),
    );
    const d = routeRequest(makeRequest(), makePolicy(), catalog);
    expect(d.ranking.map((r) => r.score)).toEqual([0.666667, 0.666667]);
    expect(d.ranking.map((r) => r.estimatedCostUsd)).toEqual([0.0012, 0.0012]);
    expect(d.ranking.map((r) => r.route)).toEqual(['boreal/deep', 'aurora/steady']);
    expect(d.primary).toBe('boreal/deep');
  });

  it('falls through to route id only when score, cost and tier are all equal', () => {
    // Two tier-5 routes tie on every earlier key; the tier-2 route loses on tier
    // even though its route id sorts first.
    const catalog = makeCatalog(
      makeModel('cirrus', 'top', { ...TIED, qualityTier: 5 }),
      makeModel('boreal', 'top', { ...TIED, qualityTier: 5 }),
      makeModel('aurora', 'low', { ...TIED, qualityTier: 2 }),
    );
    const d = routeRequest(makeRequest(), makePolicy({ weights: { cost: 1, quality: 0, latency: 0 } }), catalog);
    expect(new Set(d.ranking.map((r) => r.score))).toEqual(new Set([1]));
    expect(d.ranking.map((r) => r.route)).toEqual(['boreal/top', 'cirrus/top', 'aurora/low']);
  });

  it('orders fully tied routes by code-unit route id under every catalog permutation', () => {
    // Edge cases a different comparator would get wrong:
    //   "aurora-x/a" < "aurora/zz"   ('-' 0x2D < '/' 0x2F): route id is compared as one
    //                                string, not as a (provider, model) pair, which would
    //                                put provider "aurora" before "aurora-x".
    //   "aurora/m10" < "aurora/m9"   code-unit order, not numeric/natural collation.
    const models: ModelEntry[] = [
      makeModel('aurora', 'zz', TIED),
      makeModel('aurora', 'm9', TIED),
      makeModel('aurora-x', 'a', TIED),
      makeModel('aurora', 'm10', TIED),
    ];
    const expected = ['aurora-x/a', 'aurora/m10', 'aurora/m9', 'aurora/zz'];
    expect([...expected].sort()).toEqual(expected);

    const policy = makePolicy({ fallbackDepth: 3 });
    const decisions = permutations(models).map((order) => routeRequest(makeRequest(), policy, makeCatalog(...order)));
    expect(decisions).toHaveLength(24);
    for (const d of decisions) {
      expect(d.candidates.map((c) => c.route)).toEqual(expected);
      expect(d.ranking.map((r) => r.route)).toEqual(expected);
      expect(d.ranking.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
      expect(new Set(d.ranking.map((r) => r.score)).size).toBe(1);
      expect(d.primary).toBe(expected[0]);
      expect(d.fallbacks).toEqual(expected.slice(1));
      expect(JSON.stringify(d)).toBe(JSON.stringify(decisions[0]));
    }
  });

  it('applies the route-id order to a tied group below a clear winner', () => {
    const catalog = makeCatalog(
      makeModel('cirrus', 'tie', TIED),
      makeModel('boreal', 'tie', TIED),
      makeModel('zephyr', 'best', { ...TIED, qualityTier: 5 }),
      makeModel('aurora', 'tie', TIED),
    );
    const d = routeRequest(makeRequest(), makePolicy({ fallbackDepth: 3 }), catalog);
    expect(d.ranking.map((r) => r.route)).toEqual(['zephyr/best', 'aurora/tie', 'boreal/tie', 'cirrus/tie']);
    expect(d.primary).toBe('zephyr/best');
    expect(d.fallbacks).toEqual(['aurora/tie', 'boreal/tie', 'cirrus/tie']);
  });

  it('keeps the first route id per provider when distinct-provider fallbacks skip tied routes', () => {
    const catalog = makeCatalog(
      makeModel('boreal', 'b', TIED),
      makeModel('aurora', 'c', TIED),
      makeModel('boreal', 'a', TIED),
      makeModel('aurora', 'b', TIED),
      makeModel('aurora', 'a', TIED),
    );
    const d = routeRequest(makeRequest(), makePolicy({ fallbackDepth: 3, distinctProviderFallbacks: true }), catalog);
    expect(d.ranking.map((r) => r.route)).toEqual(['aurora/a', 'aurora/b', 'aurora/c', 'boreal/a', 'boreal/b']);
    expect(d.primary).toBe('aurora/a');
    expect(d.fallbacks).toEqual(['boreal/a']);
  });
});
