import { describe, expect, it } from 'vitest';
import { BreakerRegistry, BudgetTracker, CircuitBreaker, ManualClock } from '../src/index.js';

const config = { failureThreshold: 3, openDurationMs: 1000, halfOpenMaxProbes: 1 };

describe('CircuitBreaker', () => {
  it('opens after the configured number of consecutive failures', () => {
    const clock = new ManualClock();
    const b = new CircuitBreaker(config, clock.now);
    b.recordFailure();
    b.recordFailure();
    expect(b.state).toBe('closed');
    b.recordFailure();
    expect(b.state).toBe('open');
    expect(b.allowRequest()).toBe(false);
  });

  it('resets the failure count on success', () => {
    const b = new CircuitBreaker(config, new ManualClock().now);
    b.recordFailure();
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    b.recordFailure();
    expect(b.state).toBe('closed');
  });

  it('moves to half-open after the cool-down and admits a limited number of probes', () => {
    const clock = new ManualClock();
    const b = new CircuitBreaker({ ...config, halfOpenMaxProbes: 2 }, clock.now);
    for (let i = 0; i < 3; i++) b.recordFailure();
    clock.advance(999);
    expect(b.state).toBe('open');
    clock.advance(1);
    expect(b.state).toBe('half-open');
    expect(b.allowRequest()).toBe(true);
    expect(b.allowRequest()).toBe(true);
    expect(b.allowRequest()).toBe(false);
  });

  it('closes on a successful probe', () => {
    const clock = new ManualClock();
    const b = new CircuitBreaker(config, clock.now);
    for (let i = 0; i < 3; i++) b.recordFailure();
    clock.advance(1000);
    expect(b.allowRequest()).toBe(true);
    b.recordSuccess();
    expect(b.state).toBe('closed');
    expect(b.allowRequest()).toBe(true);
  });

  it('re-opens, restarting the cool-down, on a failed probe', () => {
    const clock = new ManualClock();
    const b = new CircuitBreaker(config, clock.now);
    for (let i = 0; i < 3; i++) b.recordFailure();
    clock.advance(1000);
    expect(b.allowRequest()).toBe(true);
    b.recordFailure();
    expect(b.state).toBe('open');
    clock.advance(999);
    expect(b.state).toBe('open');
    clock.advance(1);
    expect(b.state).toBe('half-open');
  });
});

describe('BreakerRegistry', () => {
  it('tracks providers independently and lists only open ones', () => {
    const clock = new ManualClock();
    const reg = new BreakerRegistry(config, clock.now);
    for (let i = 0; i < 3; i++) reg.get('aurora').recordFailure();
    reg.get('boreal').recordFailure();
    expect(reg.openProviders(['boreal', 'aurora', 'cirrus'])).toEqual(['aurora']);
    clock.advance(1000);
    expect(reg.openProviders(['aurora'])).toEqual([]); // half-open providers may be probed
  });
});

describe('BudgetTracker', () => {
  const policy = { windowSeconds: 60, defaultLimitUsd: 1, tenantLimitsUsd: { 'tenant-small': 0.25 }, onExceed: 'reject' as const };

  it('accumulates spend per tenant and resolves limits', () => {
    const clock = new ManualClock(0);
    const t = new BudgetTracker(policy, clock.now);
    t.record('tenant-a', 0.1);
    t.record('tenant-a', 0.2);
    expect(t.snapshot('tenant-a')).toMatchObject({ limitUsd: 1, spentUsd: 0.3 });
    expect(t.snapshot('tenant-b').spentUsd).toBe(0);
    expect(t.snapshot('tenant-small').limitUsd).toBe(0.25);
  });

  it('resets at fixed window boundaries', () => {
    const clock = new ManualClock(10_000);
    const t = new BudgetTracker(policy, clock.now);
    t.record('tenant-a', 0.5);
    expect(t.snapshot('tenant-a')).toMatchObject({ windowStartMs: 0, windowEndMs: 60_000, spentUsd: 0.5 });
    clock.set(59_999);
    expect(t.snapshot('tenant-a').spentUsd).toBe(0.5);
    clock.set(60_000);
    expect(t.snapshot('tenant-a')).toMatchObject({ windowStartMs: 60_000, spentUsd: 0 });
  });
});
