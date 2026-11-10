import { describe, expect, it } from 'vitest';
import { evaluateThresholds, formatReport, readLog, replay, routeRequest, validatePolicy, type LogRecord } from '../src/index.js';
import { baselinePolicy, candidatePolicy, exampleCatalog, examplePath, makeCatalog, makeModel, makePolicy, makeRequest } from './helpers.js';

const sampleLog = (): LogRecord[] => readLog(examplePath('requests.sample.jsonl'));

describe('replay of the bundled sample log', () => {
  it('has varied, realistic content', () => {
    const records = sampleLog();
    expect(records.length).toBeGreaterThanOrEqual(30);
    expect(new Set(records.map((r) => r.request.taskClass)).size).toBeGreaterThanOrEqual(6);
    expect(new Set(records.map((r) => r.request.tenantId)).size).toBe(3);
    const statuses = new Set(records.map((r) => r.outcome.status));
    expect(statuses).toEqual(new Set(['success', 'failed', 'not_executed']));
    expect(records.some((r) => r.decision.context.openProviders.length > 0)).toBe(true);
    expect(records.some((r) => r.decision.budget?.outcome === 'downgraded')).toBe(true);
    expect(records.some((r) => r.decision.status === 'rejected')).toBe(true);
    expect(records.some((r) => r.decision.status === 'unroutable')).toBe(true);
    expect(records.some((r) => r.outcome.attempts.some((a) => a.status === 'timeout'))).toBe(true);
    expect(records.some((r) => r.outcome.attempts.length > 1 && r.outcome.status === 'success')).toBe(true);
  });

  it('reproduces itself: replaying the recorded policy changes nothing', () => {
    const catalog = exampleCatalog();
    const report = replay(sampleLog(), baselinePolicy(catalog), catalog);
    expect(report.totals.changedPrimary).toBe(0);
    expect(report.totals.newlyUnroutable).toBe(0);
    expect(report.totals.newlyRoutable).toBe(0);
    expect(report.cost.deltaUsd).toBe(0);
    expect(report.changes).toEqual([]);
  });

  it('re-derives every recorded decision byte for byte when budget context is replayed', () => {
    const catalog = exampleCatalog();
    const policy = baselinePolicy(catalog);
    for (const rec of sampleLog()) {
      const again = routeRequest(rec.request, policy, catalog, {
        openProviders: rec.decision.context.openProviders,
        ...(rec.decision.context.budget ? { budget: rec.decision.context.budget } : {}),
      });
      expect(again).toEqual(rec.decision);
    }
  });

  it('diffs the candidate policy: changed routes, newly unroutable requests, cost delta, per-task summary', () => {
    const catalog = exampleCatalog();
    const report = replay(sampleLog(), candidatePolicy(catalog), catalog);
    expect(report.baselinePolicy).toBe('baseline');
    expect(report.candidatePolicy).toBe('candidate-cost-saver');
    expect(report.totals.requests).toBe(32);
    expect(report.totals.changedPrimary).toBe(report.changes.length);
    expect(report.totals.changedPrimary).toBeGreaterThan(0);
    expect(report.totals.newlyUnroutable).toBe(report.newlyUnroutable.length);
    expect(report.newlyUnroutable.map((u) => u.reasonCode)).toEqual(expect.arrayContaining(['BUDGET_EXCEEDED', 'NO_ELIGIBLE_CANDIDATE']));
    expect(report.cost.deltaUsd).toBeCloseTo(report.cost.candidateUsd - report.cost.baselineUsd, 9);
    expect(Object.keys(report.byTaskClass)).toEqual([...Object.keys(report.byTaskClass)].sort());
    const perTaskChanged = Object.values(report.byTaskClass).reduce((n, s) => n + s.changedPrimary, 0);
    expect(perTaskChanged).toBe(report.totals.changedPrimary);
    const classify = report.byTaskClass['classify'];
    expect(classify?.changedPrimary).toBeGreaterThan(0);
    expect(classify?.costDeltaUsd).toBeLessThan(0);
  });

  it('is deterministic', () => {
    const catalog = exampleCatalog();
    const a = JSON.stringify(replay(sampleLog(), candidatePolicy(catalog), catalog));
    const b = JSON.stringify(replay(sampleLog(), candidatePolicy(catalog), catalog));
    expect(a).toBe(b);
  });
});

describe('replay semantics', () => {
  const catalog = makeCatalog(
    makeModel('aurora', 'a', { qualityTier: 5, pricing: { inputPerMillionUsd: 10, outputPerMillionUsd: 10 } }),
    makeModel('boreal', 'b', { qualityTier: 2, pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 1 } }),
  );
  const recordWith = (policy = makePolicy({ weights: { cost: 0, quality: 1, latency: 0 } }), requestOverrides = {}): LogRecord => {
    const request = makeRequest(requestOverrides);
    return {
      schemaVersion: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      request,
      decision: routeRequest(request, policy, catalog),
      outcome: { status: 'success', servedBy: 'aurora/a', attempts: [], usage: null, actualCostUsd: 0.0012 },
    };
  };

  it('detects a changed primary and prices it', () => {
    const candidate = makePolicy({ name: 'cheap', weights: { cost: 1, quality: 0, latency: 0 } });
    const report = replay([recordWith()], candidate, catalog);
    expect(report.changes).toEqual([expect.objectContaining({ from: 'aurora/a', to: 'boreal/b' })]);
    expect(report.cost.deltaUsd).toBeLessThan(0);
    expect(report.cost.deltaPct).toBeLessThan(0);
  });

  it('detects newly unroutable requests and explains the eliminations', () => {
    const candidate = makePolicy({ name: 'strict', taskOverrides: { general: { allowProviders: ['aurora'], minQualityTier: 5 } }, deny: [{ id: 'no-aurora', reason: 'test', match: { provider: 'aurora' } }] });
    const report = replay([recordWith()], candidate, catalog);
    expect(report.totals.newlyUnroutable).toBe(1);
    expect(report.newlyUnroutable[0]).toMatchObject({ candidateStatus: 'unroutable', reasonCode: 'NO_ELIGIBLE_CANDIDATE' });
    expect(report.newlyUnroutable[0]?.eliminationCounts['DENY_RULE']).toBe(1);
    expect(report.cost.comparableRequests).toBe(0);
  });

  it('detects newly routable requests', () => {
    const strictBaseline = makePolicy({ deny: [{ id: 'all', reason: 'test', match: { tenantId: 'tenant-a' } }] });
    const report = replay([recordWith(strictBaseline)], makePolicy({ name: 'open' }), catalog);
    expect(report.totals).toMatchObject({ newlyRoutable: 1, newlyUnroutable: 0, changedPrimary: 0 });
  });

  it('does not need or touch providers: replay is a pure function of log, policy and catalog', () => {
    const rec = recordWith();
    const before = JSON.stringify(rec);
    replay([rec], makePolicy({ name: 'other' }), catalog);
    expect(JSON.stringify(rec)).toBe(before);
  });
});

describe('thresholds', () => {
  const catalog = exampleCatalog();
  const report = replay(sampleLog(), candidatePolicy(catalog), catalog);

  it('passes when everything is within limits', () => {
    expect(evaluateThresholds(report, {})).toEqual({ passed: true, violations: [] });
    expect(evaluateThresholds(report, { maxNewlyUnroutable: 99, maxChangedPrimaryPct: 100, maxCostIncreasePct: 1000, maxCostIncreaseUsd: 100 }).passed).toBe(true);
  });

  it('fails on each configured threshold with a specific message', () => {
    const result = evaluateThresholds(report, { maxNewlyUnroutable: 0, maxChangedPrimaryPct: 1, maxCostIncreasePct: 1, maxCostIncreaseUsd: 0.001 });
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(4);
    expect(result.violations[0]).toContain('changed primary routes');
    expect(result.violations.join('\n')).toContain('newly unroutable requests');
  });

  it('allows a threshold to be met exactly', () => {
    const n = report.totals.newlyUnroutable;
    expect(evaluateThresholds(report, { maxNewlyUnroutable: n }).passed).toBe(true);
    expect(evaluateThresholds(report, { maxNewlyUnroutable: n - 1 }).passed).toBe(false);
  });

  it('formats a readable report with the verdict', () => {
    const thresholds = { maxNewlyUnroutable: 0 };
    const text = formatReport(report, evaluateThresholds(report, thresholds), thresholds);
    expect(text).toContain('Per task class');
    expect(text).toContain('Newly unroutable');
    expect(text).toContain('Result: FAIL');
  });

  it('handles an empty log', () => {
    const empty = replay([], validatePolicy({ schemaVersion: 1, name: 'x', weights: { cost: 1, quality: 0, latency: 0 }, fallbackDepth: 0 }), catalog);
    expect(empty.totals.requests).toBe(0);
    expect(evaluateThresholds(empty, { maxChangedPrimaryPct: 0, maxNewlyUnroutable: 0 }).passed).toBe(true);
  });
});
