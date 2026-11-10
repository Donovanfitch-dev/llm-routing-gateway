/**
 * The routing pipeline: a pure function from
 * (request, policy, catalog, context) to an explainable decision.
 *
 *   1. hard-constraint filtering   (every rule is evaluated; all reasons kept)
 *   2. weighted scoring            (cost / quality / latency)
 *   3. deterministic ranking       (score, then cost, then quality, then route id)
 *   4. budget gate                 (reject or downgrade)
 *   5. fallback chain construction
 *
 * No clocks, randomness, I/O or hidden state: the same inputs always produce
 * a byte-identical decision.
 */

import {
  QUALITY_TIER_MAX,
  type BudgetDecision,
  type Catalog,
  type CandidateEvaluation,
  type DecisionReason,
  type DenyRule,
  type Elimination,
  type LatencyClass,
  type ModelEntry,
  type RankedCandidate,
  type RequestDescriptor,
  type RouteId,
  type RoutingContext,
  type RoutingDecision,
  type RoutingPolicy,
  type Weights,
} from './types.js';
import { compareStrings, ownValue, roundTo, routeId } from './util.js';

const LATENCY_ORDER: Record<LatencyClass, number> = { fast: 0, standard: 1, slow: 2 };
const LATENCY_SCORE: Record<LatencyClass, number> = { fast: 1, standard: 0.5, slow: 0 };

/** Estimated cost of a request on a model, in USD, rounded to nine decimals. */
export function estimateCostUsd(model: ModelEntry, inputTokens: number, outputTokens: number): number {
  const raw = (inputTokens * model.pricing.inputPerMillionUsd + outputTokens * model.pricing.outputPerMillionUsd) / 1_000_000;
  return roundTo(raw, 9);
}

function denyRuleMatches(rule: DenyRule, model: ModelEntry, request: RequestDescriptor): boolean {
  const m = rule.match;
  return (
    (m.provider === undefined || m.provider === model.provider) &&
    (m.model === undefined || m.model === model.model) &&
    (m.tenantId === undefined || m.tenantId === request.tenantId) &&
    (m.taskClass === undefined || m.taskClass === request.taskClass)
  );
}

function evaluate(
  model: ModelEntry,
  request: RequestDescriptor,
  policy: RoutingPolicy,
  minQualityTier: number,
  allowProviders: readonly string[] | undefined,
  openProviders: ReadonlySet<string>,
): CandidateEvaluation {
  const eliminations: Elimination[] = [];
  const estimatedCostUsd = estimateCostUsd(model, request.estimatedInputTokens, request.estimatedOutputTokens);

  for (const rule of policy.deny) {
    if (denyRuleMatches(rule, model, request)) eliminations.push({ code: 'DENY_RULE', detail: `${rule.id}: ${rule.reason}` });
  }
  if (allowProviders && !allowProviders.includes(model.provider)) {
    eliminations.push({ code: 'PROVIDER_NOT_ALLOWED', detail: `task class allows only: ${allowProviders.join(', ')}` });
  }
  for (const cap of request.requiredCapabilities) {
    if (model.capabilities[cap] !== true) eliminations.push({ code: 'MISSING_CAPABILITY', detail: `lacks ${cap}` });
  }
  const neededContext = request.estimatedInputTokens + request.estimatedOutputTokens;
  if (neededContext > model.capabilities.maxContextTokens) {
    eliminations.push({ code: 'CONTEXT_EXCEEDED', detail: `needs ${neededContext} tokens, max ${model.capabilities.maxContextTokens}` });
  }
  if (request.requiredRegion !== undefined && !model.regions.includes(request.requiredRegion)) {
    eliminations.push({ code: 'REGION_MISMATCH', detail: `requires ${request.requiredRegion}, offers ${model.regions.join(', ')}` });
  }
  if (request.maxLatencyClass !== undefined && LATENCY_ORDER[model.latencyClass] > LATENCY_ORDER[request.maxLatencyClass]) {
    eliminations.push({ code: 'LATENCY_EXCEEDS_LIMIT', detail: `${model.latencyClass} is slower than ${request.maxLatencyClass}` });
  }
  if (model.qualityTier < minQualityTier) {
    eliminations.push({ code: 'QUALITY_BELOW_MINIMUM', detail: `tier ${model.qualityTier} < required ${minQualityTier}` });
  }
  if (request.maxCostUsd !== undefined && estimatedCostUsd > request.maxCostUsd) {
    eliminations.push({ code: 'COST_EXCEEDS_LIMIT', detail: `estimated $${estimatedCostUsd} > max $${request.maxCostUsd}` });
  }
  if (openProviders.has(model.provider)) {
    eliminations.push({ code: 'CIRCUIT_OPEN', detail: `circuit breaker for ${model.provider} is open` });
  }

  return {
    route: routeId(model.provider, model.model),
    provider: model.provider,
    model: model.model,
    estimatedCostUsd,
    eligible: eliminations.length === 0,
    eliminations,
  };
}

function rank(
  eligible: readonly CandidateEvaluation[],
  catalogByRoute: ReadonlyMap<RouteId, ModelEntry>,
  weights: Weights,
): RankedCandidate[] {
  const costs = eligible.map((c) => c.estimatedCostUsd);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const weightSum = weights.cost + weights.quality + weights.latency;

  const scored = eligible.map((candidate) => {
    const model = catalogByRoute.get(candidate.route);
    // Eligible candidates always come from the catalog; this guards the type.
    const tier = model?.qualityTier ?? 1;
    const latencyClass = model?.latencyClass ?? 'slow';
    // Cost is min-max normalised within the eligible set (cheapest = 1, dearest = 0);
    // quality and latency use fixed absolute scales so they do not shift with the field.
    const cost = maxCost === minCost ? 1 : (maxCost - candidate.estimatedCostUsd) / (maxCost - minCost);
    const quality = (tier - 1) / (QUALITY_TIER_MAX - 1);
    const latency = LATENCY_SCORE[latencyClass];
    const score = (weights.cost * cost + weights.quality * quality + weights.latency * latency) / weightSum;
    return {
      route: candidate.route,
      tier,
      estimatedCostUsd: candidate.estimatedCostUsd,
      components: { cost: roundTo(cost, 6), quality: roundTo(quality, 6), latency: roundTo(latency, 6) },
      score: roundTo(score, 6),
    };
  });

  // Tie-breaking: higher score, then cheaper, then higher quality tier, then route id.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.estimatedCostUsd - b.estimatedCostUsd ||
      b.tier - a.tier ||
      compareStrings(a.route, b.route),
  );
  return scored.map((s, i) => ({
    rank: i + 1,
    route: s.route,
    score: s.score,
    components: s.components,
    estimatedCostUsd: s.estimatedCostUsd,
  }));
}

export function routeRequest(
  request: RequestDescriptor,
  policy: RoutingPolicy,
  catalog: Catalog,
  context: RoutingContext = {},
): RoutingDecision {
  const override = ownValue(policy.taskOverrides, request.taskClass);
  const weights = override?.weights ?? policy.weights;
  const minQualityTier = override?.minQualityTier ?? 1;
  const fallbackDepth = override?.fallbackDepth ?? policy.fallbackDepth;
  const openProviders = [...new Set(context.openProviders ?? [])].sort(compareStrings);
  const openSet = new Set(openProviders);

  const catalogByRoute = new Map<RouteId, ModelEntry>();
  for (const m of catalog.models) catalogByRoute.set(routeId(m.provider, m.model), m);

  const candidates = [...catalog.models]
    .sort((a, b) => compareStrings(routeId(a.provider, a.model), routeId(b.provider, b.model)))
    .map((m) => evaluate(m, request, policy, minQualityTier, override?.allowProviders, openSet));

  const eligible = candidates.filter((c) => c.eligible);
  const ranking = eligible.length > 0 ? rank(eligible, catalogByRoute, weights) : [];

  const decision: RoutingDecision = {
    schemaVersion: 1,
    requestId: request.id,
    policy: policy.name,
    appliedOverride: override ? request.taskClass : null,
    effectiveWeights: { ...weights },
    status: 'routed',
    reason: null,
    primary: null,
    fallbacks: [],
    context: { openProviders, budget: policy.budget && context.budget ? { ...context.budget } : null },
    candidates,
    ranking,
    budget: null,
  };

  if (ranking.length === 0) {
    decision.status = 'unroutable';
    decision.reason = {
      code: 'NO_ELIGIBLE_CANDIDATE',
      message: `all ${candidates.length} catalog entries were eliminated by hard constraints`,
    };
    return decision;
  }

  // Budget gate.
  let selectable = ranking;
  const first = ranking[0];
  if (policy.budget && context.budget && first) {
    const snapshot = context.budget;
    const remaining = roundTo(Math.max(0, snapshot.limitUsd - snapshot.spentUsd), 9);
    const budget: BudgetDecision = {
      outcome: 'within_budget',
      limitUsd: snapshot.limitUsd,
      spentUsd: snapshot.spentUsd,
      remainingUsd: remaining,
      estimatedCostUsd: first.estimatedCostUsd,
      downgradedFrom: null,
      excluded: [],
    };
    // Every ranked route over the remaining budget is excluded from the primary slot
    // AND from the fallback chain, so a fallback can never overshoot the window.
    const affordable = ranking.filter((r) => r.estimatedCostUsd <= remaining);
    budget.excluded = ranking
      .filter((r) => r.estimatedCostUsd > remaining)
      .map((r) => ({ route: r.route, estimatedCostUsd: r.estimatedCostUsd, code: 'EXCEEDS_REMAINING_BUDGET' as const }));
    selectable = affordable;
    if (first.estimatedCostUsd > remaining) {
      const best = affordable[0];
      if (policy.budget.onExceed === 'downgrade' && best) {
        budget.outcome = 'downgraded';
        budget.downgradedFrom = first.route;
      } else {
        budget.outcome = 'rejected';
        const reason: DecisionReason = {
          code: 'BUDGET_EXCEEDED',
          message:
            policy.budget.onExceed === 'reject'
              ? `estimated $${first.estimatedCostUsd} exceeds remaining $${remaining} and policy rejects`
              : `estimated $${first.estimatedCostUsd} exceeds remaining $${remaining} and no eligible route is affordable`,
        };
        decision.status = 'rejected';
        decision.reason = reason;
        decision.budget = budget;
        return decision;
      }
    }
    decision.budget = budget;
  }

  const primary = selectable[0];
  if (!primary) return decision; // unreachable: ranking was non-empty and the gate returns early
  const chain: RouteId[] = [];
  const seenProviders = new Set<string>([providerOf(primary.route)]);
  for (const next of selectable.slice(1)) {
    if (chain.length >= fallbackDepth) break;
    const provider = providerOf(next.route);
    if (policy.distinctProviderFallbacks && seenProviders.has(provider)) continue;
    seenProviders.add(provider);
    chain.push(next.route);
  }
  decision.primary = primary.route;
  decision.fallbacks = chain;
  return decision;
}

export function providerOf(route: RouteId): string {
  const idx = route.indexOf('/');
  return idx === -1 ? route : route.slice(0, idx);
}
