/**
 * Per-tenant spend tracking over fixed, clock-aligned windows.
 *
 * A window is `[k * windowMs, (k + 1) * windowMs)` for integer k; spend resets
 * when a tenant's first request lands in a new window. State is in-process.
 */

import type { BudgetPolicy, BudgetSnapshot } from './types.js';
import type { Clock } from './util.js';
import { ownValue, roundTo } from './util.js';

export class BudgetTracker {
  private readonly windowMs: number;
  private readonly spend = new Map<string, { windowStartMs: number; spentUsd: number }>();

  constructor(
    private readonly policy: BudgetPolicy,
    private readonly clock: Clock,
  ) {
    this.windowMs = policy.windowSeconds * 1000;
  }

  limitFor(tenantId: string): number {
    return ownValue(this.policy.tenantLimitsUsd, tenantId) ?? this.policy.defaultLimitUsd;
  }

  snapshot(tenantId: string): BudgetSnapshot {
    const now = this.clock();
    const windowStartMs = Math.floor(now / this.windowMs) * this.windowMs;
    const entry = this.spend.get(tenantId);
    const spentUsd = entry && entry.windowStartMs === windowStartMs ? entry.spentUsd : 0;
    return {
      limitUsd: this.limitFor(tenantId),
      spentUsd,
      windowStartMs,
      windowEndMs: windowStartMs + this.windowMs,
    };
  }

  /** Record actual spend against the tenant's current window. */
  record(tenantId: string, costUsd: number): void {
    const snap = this.snapshot(tenantId);
    this.spend.set(tenantId, {
      windowStartMs: snap.windowStartMs,
      spentUsd: roundTo(snap.spentUsd + costUsd, 9),
    });
  }
}
