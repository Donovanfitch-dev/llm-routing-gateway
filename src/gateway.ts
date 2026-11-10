/**
 * The gateway ties routing to execution:
 *
 *   breaker states + budget window  ->  routeRequest  ->  walk primary and fallbacks
 *
 * Retryable errors and timeouts advance down the chain and count against the
 * provider's circuit breaker. Non-retryable errors stop the walk: they describe
 * the request, not provider health, so trying another route would not help and
 * they are treated as evidence the provider is alive.
 */

import { BreakerRegistry, DEFAULT_BREAKER_CONFIG } from './breaker.js';
import { BudgetTracker } from './budget.js';
import type { LogSink } from './log.js';
import { ProviderError, type ProviderAdapter } from './providers.js';
import { estimateCostUsd, providerOf, routeRequest } from './router.js';
import type { Attempt, Catalog, LogRecord, ModelEntry, Outcome, RequestDescriptor, RoutingPolicy } from './types.js';
import { ownValue, roundTo, routeId, systemClock, type Clock } from './util.js';

export interface GatewayOptions {
  catalog: Catalog;
  policy: RoutingPolicy;
  providers: Readonly<Record<string, ProviderAdapter>>;
  clock?: Clock;
  /** Per-attempt timeout in milliseconds. Default 10 000. */
  timeoutMs?: number;
  sink?: LogSink;
  breakers?: BreakerRegistry;
  budget?: BudgetTracker;
}

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderError('TIMEOUT', `no response within ${ms}ms`, true));
    }, ms);
    let pending: Promise<T>;
    try {
      pending = run(controller.signal);
    } catch (error) {
      // A synchronous throw must not leave the timer armed.
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export class Gateway {
  private readonly catalog: Catalog;
  private readonly policy: RoutingPolicy;
  private readonly providers: Readonly<Record<string, ProviderAdapter>>;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly sink: LogSink | undefined;
  readonly breakers: BreakerRegistry;
  readonly budget: BudgetTracker | undefined;
  private readonly modelsByRoute = new Map<string, ModelEntry>();

  constructor(options: GatewayOptions) {
    this.catalog = options.catalog;
    this.policy = options.policy;
    this.providers = options.providers;
    this.clock = options.clock ?? systemClock;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.sink = options.sink;
    this.breakers = options.breakers ?? new BreakerRegistry(options.policy.breaker ?? DEFAULT_BREAKER_CONFIG, this.clock);
    this.budget = options.budget ?? (options.policy.budget ? new BudgetTracker(options.policy.budget, this.clock) : undefined);
    for (const m of this.catalog.models) this.modelsByRoute.set(routeId(m.provider, m.model), m);
  }

  /** Route and execute one request, append it to the sink (if any) and return the record. */
  async handle(request: RequestDescriptor): Promise<LogRecord> {
    const providerNames = new Set(this.catalog.models.map((m) => m.provider));
    const decision = routeRequest(request, this.policy, this.catalog, {
      openProviders: this.breakers.openProviders(providerNames),
      ...(this.budget ? { budget: this.budget.snapshot(request.tenantId) } : {}),
    });

    const outcome: Outcome = { status: 'not_executed', servedBy: null, attempts: [], usage: null, actualCostUsd: null };

    if (decision.status === 'routed' && decision.primary !== null) {
      for (const route of [decision.primary, ...decision.fallbacks]) {
        const model = this.modelsByRoute.get(route);
        const adapter = ownValue(this.providers, providerOf(route));
        if (!model || !adapter) {
          outcome.attempts.push(skipped(route, 'NO_ADAPTER'));
          continue;
        }
        const breaker = this.breakers.get(model.provider);
        if (!breaker.allowRequest()) {
          outcome.attempts.push(skipped(route, 'CIRCUIT_OPEN'));
          continue;
        }
        try {
          const result = await withTimeout(
            (signal) =>
              adapter.invoke(
                {
                  requestId: request.id,
                  tenantId: request.tenantId,
                  model: model.model,
                  inputTokens: request.estimatedInputTokens,
                  outputTokens: request.estimatedOutputTokens,
                },
                signal,
              ),
            this.timeoutMs,
          );
          breaker.recordSuccess();
          outcome.attempts.push({ route, status: 'ok', errorCode: null, retryable: null, skipReason: null });
          outcome.status = 'success';
          outcome.servedBy = route;
          outcome.usage = { inputTokens: result.inputTokens, outputTokens: result.outputTokens };
          outcome.actualCostUsd = roundTo(estimateCostUsd(model, result.inputTokens, result.outputTokens), 9);
          this.budget?.record(request.tenantId, outcome.actualCostUsd);
          break;
        } catch (error) {
          const failure = error instanceof ProviderError ? error : new ProviderError('UNKNOWN', error instanceof Error ? error.message : String(error), true);
          outcome.attempts.push({
            route,
            status: failure.code === 'TIMEOUT' ? 'timeout' : 'error',
            errorCode: failure.code,
            retryable: failure.retryable,
            skipReason: null,
          });
          if (failure.retryable) {
            breaker.recordFailure();
            continue;
          }
          breaker.recordSuccess(); // the provider answered; the request itself was at fault
          outcome.status = 'failed';
          break;
        }
      }
      if (outcome.status === 'not_executed') outcome.status = 'exhausted';
    }

    const record: LogRecord = {
      schemaVersion: 1,
      timestamp: new Date(this.clock()).toISOString(),
      request,
      decision,
      outcome,
    };
    this.sink?.write(record);
    return record;
  }
}

function skipped(route: string, reason: 'CIRCUIT_OPEN' | 'NO_ADAPTER'): Attempt {
  return { route, status: 'skipped', errorCode: null, retryable: null, skipReason: reason };
}
