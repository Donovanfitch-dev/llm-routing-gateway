/**
 * Replay harness: re-route every recorded request against a candidate
 * policy/catalog and diff the result against what was recorded.
 *
 * Nothing is executed. This module imports the router and budget arithmetic
 * only; it has no access to provider adapters, breakers or the gateway.
 *
 * Fidelity notes (see docs/design.md):
 *  - circuit-breaker state is taken from each record's recorded context, so
 *    differences are attributable to the policy and not to past outages;
 *  - budgets are re-simulated from the log's timestamps, charging the
 *    candidate's estimated cost for each request that originally succeeded.
 */

import { BudgetTracker } from './budget.js';
import { routeRequest } from './router.js';
import type { Catalog, DecisionStatus, LogRecord, RoutingDecision, RoutingPolicy } from './types.js';
import { compareStrings, roundTo } from './util.js';

export interface ReplayThresholds {
  /** Maximum share of requests whose primary route changed, in percent. */
  maxChangedPrimaryPct?: number;
  /** Maximum number of requests that were routed before and are not now. */
  maxNewlyUnroutable?: number;
  /** Maximum increase of estimated cost over comparable requests, in percent. */
  maxCostIncreasePct?: number;
  /** Maximum increase of estimated cost over comparable requests, in USD. */
  maxCostIncreaseUsd?: number;
}

export interface RouteChange {
  requestId: string;
  taskClass: string;
  tenantId: string;
  from: string;
  to: string;
  baselineCostUsd: number;
  candidateCostUsd: number;
}

export interface NewlyUnroutable {
  requestId: string;
  taskClass: string;
  tenantId: string;
  baselinePrimary: string;
  candidateStatus: DecisionStatus;
  reasonCode: string;
  reasonMessage: string;
  /** Elimination codes across all catalog entries, with counts. Empty when the cause was the budget. */
  eliminationCounts: Record<string, number>;
}

export interface TaskClassSummary {
  requests: number;
  unchanged: number;
  changedPrimary: number;
  newlyUnroutable: number;
  newlyRoutable: number;
  stillUnroutable: number;
  baselineCostUsd: number;
  candidateCostUsd: number;
  costDeltaUsd: number;
}

export interface ReplayReport {
  baselinePolicy: string;
  candidatePolicy: string;
  totals: {
    requests: number;
    unchanged: number;
    changedPrimary: number;
    newlyUnroutable: number;
    newlyRoutable: number;
    stillUnroutable: number;
  };
  /** Estimated cost over requests routed in both baseline and candidate. */
  cost: {
    comparableRequests: number;
    baselineUsd: number;
    candidateUsd: number;
    deltaUsd: number;
    /** Percent change over comparable requests; null when the baseline is zero and the cost rose (unbounded). */
    deltaPct: number | null;
  };
  byTaskClass: Record<string, TaskClassSummary>;
  changes: RouteChange[];
  newlyUnroutable: NewlyUnroutable[];
}

export interface ThresholdResult {
  passed: boolean;
  violations: string[];
}

export interface ReplayOptions {
  /** Re-simulate tenant budgets from log timestamps. Default: true when the candidate policy has a budget. */
  simulateBudgets?: boolean;
}

function baselineCost(decision: RoutingDecision): number {
  const entry = decision.ranking.find((r) => r.route === decision.primary);
  return entry?.estimatedCostUsd ?? 0;
}

function emptySummary(): TaskClassSummary {
  return {
    requests: 0,
    unchanged: 0,
    changedPrimary: 0,
    newlyUnroutable: 0,
    newlyRoutable: 0,
    stillUnroutable: 0,
    baselineCostUsd: 0,
    candidateCostUsd: 0,
    costDeltaUsd: 0,
  };
}

export function replay(
  records: readonly LogRecord[],
  candidatePolicy: RoutingPolicy,
  candidateCatalog: Catalog,
  options: ReplayOptions = {},
): ReplayReport {
  const simulate = (options.simulateBudgets ?? true) && candidatePolicy.budget !== undefined;
  let simulatedNow = 0;
  const tracker = simulate && candidatePolicy.budget ? new BudgetTracker(candidatePolicy.budget, () => simulatedNow) : undefined;

  const totals = { requests: 0, unchanged: 0, changedPrimary: 0, newlyUnroutable: 0, newlyRoutable: 0, stillUnroutable: 0 };
  // A Map, not an object: task class names are user data and may be "constructor" or "toString".
  const byTaskClass = new Map<string, TaskClassSummary>();
  const changes: RouteChange[] = [];
  const newlyUnroutable: NewlyUnroutable[] = [];
  let comparable = 0;
  let baselineUsd = 0;
  let candidateUsd = 0;
  let baselinePolicyName = '';

  for (const record of records) {
    const { request, decision: baseline } = record;
    baselinePolicyName = baselinePolicyName || baseline.policy;
    simulatedNow = Date.parse(record.timestamp);

    const candidate = routeRequest(request, candidatePolicy, candidateCatalog, {
      openProviders: baseline.context.openProviders,
      ...(tracker ? { budget: tracker.snapshot(request.tenantId) } : {}),
    });

    let summary = byTaskClass.get(request.taskClass);
    if (!summary) {
      summary = emptySummary();
      byTaskClass.set(request.taskClass, summary);
    }
    summary.requests += 1;
    totals.requests += 1;

    const baselineRouted = baseline.status === 'routed' && baseline.primary !== null;
    const candidateRouted = candidate.status === 'routed' && candidate.primary !== null;
    const baselineUsdThis = baselineRouted ? baselineCost(baseline) : 0;
    const candidateUsdThis = candidateRouted ? (candidate.ranking.find((r) => r.route === candidate.primary)?.estimatedCostUsd ?? 0) : 0;

    if (baselineRouted && candidateRouted) {
      comparable += 1;
      baselineUsd += baselineUsdThis;
      candidateUsd += candidateUsdThis;
      summary.baselineCostUsd += baselineUsdThis;
      summary.candidateCostUsd += candidateUsdThis;
      if (baseline.primary === candidate.primary) {
        summary.unchanged += 1;
        totals.unchanged += 1;
      } else {
        summary.changedPrimary += 1;
        totals.changedPrimary += 1;
        changes.push({
          requestId: request.id,
          taskClass: request.taskClass,
          tenantId: request.tenantId,
          from: baseline.primary ?? '',
          to: candidate.primary ?? '',
          baselineCostUsd: baselineUsdThis,
          candidateCostUsd: candidateUsdThis,
        });
      }
    } else if (baselineRouted && !candidateRouted) {
      summary.newlyUnroutable += 1;
      totals.newlyUnroutable += 1;
      const counts: Record<string, number> = {};
      if (candidate.status === 'unroutable') {
        for (const cand of candidate.candidates) for (const e of cand.eliminations) counts[e.code] = (counts[e.code] ?? 0) + 1;
      }
      newlyUnroutable.push({
        requestId: request.id,
        taskClass: request.taskClass,
        tenantId: request.tenantId,
        baselinePrimary: baseline.primary ?? '',
        candidateStatus: candidate.status,
        reasonCode: candidate.reason?.code ?? 'UNKNOWN',
        reasonMessage: candidate.reason?.message ?? '',
        eliminationCounts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => compareStrings(a, b))),
      });
    } else if (!baselineRouted && candidateRouted) {
      summary.newlyRoutable += 1;
      totals.newlyRoutable += 1;
    } else {
      summary.stillUnroutable += 1;
      totals.stillUnroutable += 1;
    }

    // Budget simulation: only requests that really consumed budget in the original run are charged.
    // If the candidate keeps the recorded primary, assume the recorded outcome (including any
    // fallback that actually served) and charge the recorded cost; otherwise charge the candidate's estimate.
    if (tracker && candidateRouted && record.outcome.status === 'success') {
      const keptPrimary = candidate.primary === baseline.primary && record.outcome.actualCostUsd !== null;
      tracker.record(request.tenantId, keptPrimary ? (record.outcome.actualCostUsd ?? 0) : candidateUsdThis);
    }
  }

  for (const summary of byTaskClass.values()) {
    summary.baselineCostUsd = roundTo(summary.baselineCostUsd, 9);
    summary.candidateCostUsd = roundTo(summary.candidateCostUsd, 9);
    summary.costDeltaUsd = roundTo(summary.candidateCostUsd - summary.baselineCostUsd, 9);
  }
  baselineUsd = roundTo(baselineUsd, 9);
  candidateUsd = roundTo(candidateUsd, 9);
  const deltaUsd = roundTo(candidateUsd - baselineUsd, 9);

  return {
    baselinePolicy: baselinePolicyName,
    candidatePolicy: candidatePolicy.name,
    totals,
    cost: {
      comparableRequests: comparable,
      baselineUsd,
      candidateUsd,
      deltaUsd,
      // With a zero baseline the percentage is undefined: 0 when nothing rose, null (unbounded) for any increase.
      deltaPct: baselineUsd === 0 ? (deltaUsd > 0 ? null : 0) : roundTo((deltaUsd / baselineUsd) * 100, 2),
    },
    byTaskClass: Object.fromEntries([...byTaskClass.entries()].sort(([a], [b]) => compareStrings(a, b))),
    changes,
    newlyUnroutable,
  };
}

export function evaluateThresholds(report: ReplayReport, thresholds: ReplayThresholds): ThresholdResult {
  const violations: string[] = [];
  const changedPct = report.totals.requests === 0 ? 0 : (report.totals.changedPrimary / report.totals.requests) * 100;

  if (thresholds.maxChangedPrimaryPct !== undefined && changedPct > thresholds.maxChangedPrimaryPct) {
    violations.push(`changed primary routes ${roundTo(changedPct, 2)}% exceeds limit ${thresholds.maxChangedPrimaryPct}%`);
  }
  if (thresholds.maxNewlyUnroutable !== undefined && report.totals.newlyUnroutable > thresholds.maxNewlyUnroutable) {
    violations.push(`newly unroutable requests ${report.totals.newlyUnroutable} exceeds limit ${thresholds.maxNewlyUnroutable}`);
  }
  if (thresholds.maxCostIncreasePct !== undefined) {
    if (report.cost.deltaPct === null) {
      violations.push(`estimated cost rose from a zero baseline to $${report.cost.candidateUsd}: unbounded in percent, exceeds limit ${thresholds.maxCostIncreasePct}%`);
    } else if (report.cost.deltaPct > thresholds.maxCostIncreasePct) {
      violations.push(`estimated cost increase ${report.cost.deltaPct}% exceeds limit ${thresholds.maxCostIncreasePct}%`);
    }
  }
  if (thresholds.maxCostIncreaseUsd !== undefined && report.cost.deltaUsd > thresholds.maxCostIncreaseUsd) {
    violations.push(`estimated cost increase $${report.cost.deltaUsd} exceeds limit $${thresholds.maxCostIncreaseUsd}`);
  }
  return { passed: violations.length === 0, violations };
}

function usd(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(6)}`;
}

export function formatReport(report: ReplayReport, result: ThresholdResult, thresholds: ReplayThresholds): string {
  const t = report.totals;
  const lines: string[] = [];
  lines.push(`Replay: ${report.baselinePolicy} (recorded) -> ${report.candidatePolicy} (candidate)`);
  lines.push('');
  lines.push(`Requests replayed      ${t.requests}`);
  lines.push(`  unchanged            ${t.unchanged}`);
  lines.push(`  changed primary      ${t.changedPrimary}`);
  lines.push(`  newly unroutable     ${t.newlyUnroutable}`);
  lines.push(`  newly routable       ${t.newlyRoutable}`);
  lines.push(`  still unroutable     ${t.stillUnroutable}`);
  lines.push('');
  lines.push(`Estimated cost over ${report.cost.comparableRequests} comparable requests`);
  lines.push(`  baseline             ${usd(report.cost.baselineUsd)}`);
  lines.push(`  candidate            ${usd(report.cost.candidateUsd)}`);
  lines.push(`  delta                ${usd(report.cost.deltaUsd)} (${report.cost.deltaPct === null ? 'n/a, zero baseline' : `${report.cost.deltaPct >= 0 ? '+' : ''}${report.cost.deltaPct}%`})`);
  lines.push('');
  lines.push('Per task class');
  lines.push('  task class        reqs  changed  unroutable      baseline     candidate         delta');
  for (const [name, s] of Object.entries(report.byTaskClass)) {
    lines.push(
      `  ${name.padEnd(16)}  ${String(s.requests).padStart(4)}  ${String(s.changedPrimary).padStart(7)}  ${String(s.newlyUnroutable).padStart(10)}  ${usd(s.baselineCostUsd).padStart(12)}  ${usd(s.candidateCostUsd).padStart(12)}  ${usd(s.costDeltaUsd).padStart(12)}`,
    );
  }
  if (report.changes.length > 0) {
    lines.push('');
    lines.push('Changed primary routes');
    for (const c of report.changes) lines.push(`  ${c.requestId.padEnd(10)} ${c.taskClass.padEnd(16)} ${c.from} -> ${c.to}`);
  }
  if (report.newlyUnroutable.length > 0) {
    lines.push('');
    lines.push('Newly unroutable');
    for (const u of report.newlyUnroutable) {
      const why = Object.entries(u.eliminationCounts).map(([k, v]) => `${k} x${v}`).join(', ');
      lines.push(`  ${u.requestId.padEnd(10)} ${u.taskClass.padEnd(16)} was ${u.baselinePrimary}; now ${u.candidateStatus} [${u.reasonCode}]`);
      lines.push(`      ${why || u.reasonMessage}`);
    }
  }
  lines.push('');
  const active = Object.entries(thresholds).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${String(v)}`);
  lines.push(`Thresholds: ${active.length > 0 ? active.join(', ') : '(none)'}`);
  if (result.passed) {
    lines.push('Result: PASS');
  } else {
    lines.push('Result: FAIL');
    for (const v of result.violations) lines.push(`  - ${v}`);
  }
  return `${lines.join('\n')}\n`;
}
