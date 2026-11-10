/**
 * Regenerates examples/requests.sample.jsonl.
 *
 * Runs a synthetic workload through the real gateway with the baseline policy
 * and scripted mock providers, so the log contains genuine decisions and
 * outcomes: an outage that trips a circuit breaker, a timeout, a
 * non-retryable error, a half-open probe and budget downgrades.
 * Everything is synthetic; time comes from a manual clock, so the output is
 * reproducible.
 *
 *   npm run generate:log
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Gateway,
  ManualClock,
  MemorySink,
  MockProvider,
  loadCatalog,
  loadPolicy,
  serializeRecords,
  type Capability,
  type LatencyClass,
  type MockBehavior,
  type MockScript,
  type RequestDescriptor,
} from '../src/index.js';

interface Spec {
  tenant: string;
  task: string;
  caps?: Capability[];
  inTok: number;
  outTok: number;
  region?: string;
  maxLatency?: LatencyClass;
  maxCost?: number;
}

const SPECS: Spec[] = [
  { tenant: 'tenant-alpha', task: 'summarize', inTok: 2000, outTok: 400 },
  { tenant: 'tenant-alpha', task: 'classify', caps: ['jsonOutput'], inTok: 300, outTok: 20 },
  { tenant: 'tenant-beta', task: 'chat', inTok: 800, outTok: 300 },
  { tenant: 'tenant-gamma', task: 'summarize', inTok: 6000, outTok: 500 },
  { tenant: 'tenant-alpha', task: 'code-review', caps: ['tools'], inTok: 12000, outTok: 1500 },
  { tenant: 'tenant-beta', task: 'extract-json', caps: ['jsonOutput'], inTok: 3000, outTok: 600, region: 'eu' },
  { tenant: 'tenant-gamma', task: 'classify', caps: ['jsonOutput'], inTok: 500, outTok: 10 },
  { tenant: 'tenant-alpha', task: 'vision-describe', caps: ['vision'], inTok: 2500, outTok: 300 },
  { tenant: 'tenant-beta', task: 'code-review', caps: ['tools'], inTok: 20000, outTok: 2000 },
  { tenant: 'tenant-alpha', task: 'chat', inTok: 600, outTok: 250, maxLatency: 'fast' },
  { tenant: 'tenant-gamma', task: 'code-review', caps: ['tools'], inTok: 9000, outTok: 1200 },
  { tenant: 'tenant-alpha', task: 'code-review', caps: ['tools'], inTok: 15000, outTok: 1800 },
  { tenant: 'tenant-beta', task: 'code-review', caps: ['tools'], inTok: 8000, outTok: 1000 },
  { tenant: 'tenant-alpha', task: 'code-review', caps: ['tools'], inTok: 11000, outTok: 1400 },
  { tenant: 'tenant-gamma', task: 'chat', inTok: 400, outTok: 200 },
  { tenant: 'tenant-alpha', task: 'summarize', inTok: 3500, outTok: 450 },
  { tenant: 'tenant-beta', task: 'classify', caps: ['jsonOutput'], inTok: 250, outTok: 15 },
  { tenant: 'tenant-alpha', task: 'vision-describe', caps: ['vision'], inTok: 40000, outTok: 500 },
  { tenant: 'tenant-beta', task: 'extract-json', caps: ['jsonOutput', 'tools'], inTok: 5000, outTok: 900 },
  { tenant: 'tenant-alpha', task: 'code-review', caps: ['tools'], inTok: 30000, outTok: 2500, region: 'eu' },
  { tenant: 'tenant-gamma', task: 'summarize', inTok: 25000, outTok: 1500 },
  { tenant: 'tenant-alpha', task: 'chat', inTok: 1200, outTok: 400 },
  { tenant: 'tenant-beta', task: 'vision-describe', caps: ['vision'], inTok: 1800, outTok: 250, region: 'us' },
  { tenant: 'tenant-alpha', task: 'extract-json', caps: ['jsonOutput'], inTok: 2200, outTok: 500, maxCost: 0.002 },
  { tenant: 'tenant-gamma', task: 'vision-describe', caps: ['vision'], inTok: 3000, outTok: 400 },
  { tenant: 'tenant-alpha', task: 'summarize', inTok: 800, outTok: 150, maxLatency: 'fast' },
  { tenant: 'tenant-beta', task: 'chat', inTok: 5000, outTok: 1200 },
  { tenant: 'tenant-alpha', task: 'code-review', caps: ['tools'], inTok: 7000, outTok: 900 },
  { tenant: 'tenant-alpha', task: 'classify', inTok: 150, outTok: 5 },
  { tenant: 'tenant-beta', task: 'summarize', inTok: 4500, outTok: 700 },
  { tenant: 'tenant-alpha', task: 'translate', inTok: 1500, outTok: 1500 },
  { tenant: 'tenant-beta', task: 'vision-describe', caps: ['vision'], inTok: 2000, outTok: 300, region: 'apac' },
];

/** Request numbers (1-based) during which provider `aurora` is unavailable. */
const AURORA_OUTAGE = new Set([9, 10, 11, 12, 13, 14, 15, 16]);
/** Per-request faults by provider, for variety. */
const FAULTS: Record<number, Record<string, MockBehavior>> = {
  3: { boreal: { kind: 'hang' } },
  19: { aurora: { kind: 'error', code: 'INVALID_REQUEST', retryable: false }, boreal: { kind: 'error', code: 'INVALID_REQUEST', retryable: false }, cirrus: { kind: 'error', code: 'INVALID_REQUEST', retryable: false } },
};

const START_MS = Date.UTC(2026, 2, 2, 9, 0, 0);
const STEP_MS = 60_000;

async function main(): Promise<void> {
  const catalog = loadCatalog(fileURLToPath(new URL('./catalog.json', import.meta.url)));
  const policy = loadPolicy(fileURLToPath(new URL('./policy.baseline.json', import.meta.url)), catalog);
  const clock = new ManualClock(START_MS);
  const sink = new MemorySink();

  const scriptFor = (provider: string): MockScript => (call) => {
    const n = Number(call.requestId.replace('req-', ''));
    const fault = FAULTS[n]?.[provider];
    if (fault) return fault;
    if (provider === 'aurora' && AURORA_OUTAGE.has(n)) return { kind: 'error', code: 'UNAVAILABLE', retryable: true };
    return { kind: 'ok' };
  };
  const providers = Object.fromEntries(
    ['aurora', 'boreal', 'cirrus'].map((p) => [p, new MockProvider(p, scriptFor(p))]),
  );

  const gateway = new Gateway({ catalog, policy, providers, clock: clock.now, sink, timeoutMs: 15 });

  for (const [i, spec] of SPECS.entries()) {
    const request: RequestDescriptor = {
      id: `req-${String(i + 1).padStart(3, '0')}`,
      tenantId: spec.tenant,
      taskClass: spec.task,
      requiredCapabilities: spec.caps ?? [],
      estimatedInputTokens: spec.inTok,
      estimatedOutputTokens: spec.outTok,
    };
    if (spec.maxCost !== undefined) request.maxCostUsd = spec.maxCost;
    if (spec.maxLatency !== undefined) request.maxLatencyClass = spec.maxLatency;
    if (spec.region !== undefined) request.requiredRegion = spec.region;
    await gateway.handle(request);
    clock.advance(STEP_MS);
  }

  const outPath = fileURLToPath(new URL('./requests.sample.jsonl', import.meta.url));
  writeFileSync(outPath, serializeRecords(sink.records), 'utf8');

  for (const r of sink.records) {
    const attempts = r.outcome.attempts.map((a) => `${a.route}:${a.status}${a.errorCode ? `(${a.errorCode})` : ''}${a.skipReason ? `(${a.skipReason})` : ''}`).join(' ');
    const open = r.decision.context.openProviders.join(',');
    process.stdout.write(
      `${r.request.id} ${r.request.tenantId.padEnd(13)} ${r.request.taskClass.padEnd(15)} ${r.decision.status.padEnd(10)} ${r.outcome.status.padEnd(12)} budget=${r.decision.budget?.outcome ?? '-'} open=[${open}] ${attempts}\n`,
    );
  }
  process.stdout.write(`wrote ${sink.records.length} records\n`);
}

await main();
