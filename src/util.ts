import type { RouteId } from './types.js';

/** Injectable time source returning epoch milliseconds. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

/** A manually advanced clock for deterministic tests and sample generation. */
export class ManualClock {
  private nowMs: number;

  constructor(startMs = 0) {
    this.nowMs = startMs;
  }

  now = (): number => this.nowMs;

  advance(ms: number): void {
    this.nowMs += ms;
  }

  set(ms: number): void {
    this.nowMs = ms;
  }
}

export function routeId(provider: string, model: string): RouteId {
  return `${provider}/${model}`;
}

/** Round to a fixed number of decimals so floating point noise never leaks into records. */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Locale-independent string comparison, used for deterministic tie-breaking. */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
