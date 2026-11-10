/**
 * Per-provider circuit breaker (closed / open / half-open) with an injectable clock.
 *
 *  - closed:    requests flow; consecutive availability failures are counted.
 *  - open:      requests are refused until `openDurationMs` has elapsed.
 *  - half-open: up to `halfOpenMaxProbes` trial requests are admitted; one
 *               success closes the breaker, one failure re-opens it.
 *
 * State is held in process memory and is not shared between processes.
 */

import type { BreakerPolicy } from './types.js';
import type { Clock } from './util.js';

export type BreakerState = 'closed' | 'open' | 'half-open';

export const DEFAULT_BREAKER_CONFIG: BreakerPolicy = {
  failureThreshold: 3,
  openDurationMs: 30_000,
  halfOpenMaxProbes: 1,
};

export class CircuitBreaker {
  private current: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAtMs = 0;
  private probesInFlight = 0;

  constructor(
    private readonly config: BreakerPolicy,
    private readonly clock: Clock,
  ) {}

  /** Current state. An open breaker whose cool-down has elapsed reports half-open. */
  get state(): BreakerState {
    if (this.current === 'open' && this.clock() - this.openedAtMs >= this.config.openDurationMs) {
      this.current = 'half-open';
      this.probesInFlight = 0;
    }
    return this.current;
  }

  /**
   * Ask permission to send a request. In half-open state this consumes one
   * probe slot, which is released by recordSuccess / recordFailure.
   */
  allowRequest(): boolean {
    switch (this.state) {
      case 'closed':
        return true;
      case 'open':
        return false;
      case 'half-open':
        if (this.probesInFlight >= this.config.halfOpenMaxProbes) return false;
        this.probesInFlight += 1;
        return true;
    }
  }

  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.current = 'closed';
      this.probesInFlight = 0;
    }
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    const state = this.state;
    if (state === 'half-open') {
      this.trip();
      return;
    }
    if (state === 'closed') {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.config.failureThreshold) this.trip();
    }
  }

  private trip(): void {
    this.current = 'open';
    this.openedAtMs = this.clock();
    this.consecutiveFailures = 0;
    this.probesInFlight = 0;
  }
}

/** Lazily creates one breaker per provider, all sharing one config and clock. */
export class BreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly config: BreakerPolicy,
    private readonly clock: Clock,
  ) {}

  get(provider: string): CircuitBreaker {
    let breaker = this.breakers.get(provider);
    if (!breaker) {
      breaker = new CircuitBreaker(this.config, this.clock);
      this.breakers.set(provider, breaker);
    }
    return breaker;
  }

  /** Providers (from the given set) whose breaker is currently open. Half-open providers are not listed: they may be probed. */
  openProviders(providers: Iterable<string>): string[] {
    return [...providers].filter((p) => this.get(p).state === 'open').sort();
  }
}
