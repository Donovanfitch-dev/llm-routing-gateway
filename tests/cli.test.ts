import { describe, expect, it } from 'vitest';
import { runReplay } from '../src/cli/replay.js';
import { runRoute } from '../src/cli/route.js';

function capture(run: (argv: string[], io: { out(t: string): void; err(t: string): void }) => number, argv: string[]) {
  let out = '';
  let err = '';
  const code = run(argv, { out: (t) => (out += t), err: (t) => (err += t) });
  return { code, out, err };
}

describe('route CLI', () => {
  it('routes the bundled sample request and prints an explanation', () => {
    const { code, out } = capture(runRoute, []);
    expect(code).toBe(0);
    expect(out).toContain('Primary   cirrus/cirrus-flash');
    expect(out).toContain('Eliminated (6 of 8)');
    expect(out).toContain('REGION_MISMATCH');
  });

  it('builds a request from flags', () => {
    const { code, out } = capture(runRoute, ['--task', 'classify', '--capability', 'jsonOutput', '--in', '200', '--out', '10', '--tenant', 'tenant-beta']);
    expect(code).toBe(0);
    expect(out).toContain('task=classify');
    expect(out).toContain('override=classify');
  });

  it('simulates open breakers and spent budget', () => {
    const open = capture(runRoute, ['--task', 'code-review', '--capability', 'tools', '--open-provider', 'aurora']);
    expect(open.out).toContain('Breakers  open: aurora');
    expect(open.out).toContain('CIRCUIT_OPEN');
    const broke = capture(runRoute, ['--task', 'code-review', '--capability', 'tools', '--tenant', 'tenant-gamma', '--spent', '0.049', '--in', '20000']);
    expect(broke.out).toContain('BUDGET_EXCEEDED');
    expect(broke.code).toBe(1);
  });

  it('emits JSON on request', () => {
    const { out } = capture(runRoute, ['--json']);
    const parsed = JSON.parse(out) as { decision: { status: string }; request: { id: string } };
    expect(parsed.decision.status).toBe('routed');
    expect(parsed.request.id).toBe('demo-001');
  });

  it('exits 1 for unroutable requests and 2 for bad input', () => {
    expect(capture(runRoute, ['--region', 'mars']).code).toBe(1);
    const bad = capture(runRoute, ['--capability', 'telepathy']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('requiredCapabilities[0]');
    expect(capture(runRoute, ['--in', 'lots']).err).toContain('--in expects a number');
    expect(capture(runRoute, ['--bogus']).code).toBe(2);
    expect(capture(runRoute, ['--request', 'examples/sample-request.json', '--task', 'chat']).err).toContain('not both');
    expect(capture(runRoute, ['--policy', 'examples/missing.json']).err).toContain('cannot be read');
    expect(capture(runRoute, ['--help']).out).toContain('Usage: route');
  });
});

describe('replay CLI', () => {
  it('replays the bundled log against the candidate policy and fails the default gate', () => {
    const { code, out } = capture(runReplay, []);
    expect(code).toBe(1);
    expect(out).toContain('Replay: baseline (recorded) -> candidate-cost-saver (candidate)');
    expect(out).toContain('Requests replayed      32');
    expect(out).toContain('Result: FAIL');
  });

  it('passes when thresholds are relaxed, and can print JSON', () => {
    const text = capture(runReplay, ['--max-newly-unroutable', '10']);
    expect(text.code).toBe(0);
    expect(text.out).toContain('Result: PASS');
    const json = capture(runReplay, ['--max-newly-unroutable', '10', '--format', 'json']);
    const parsed = JSON.parse(json.out) as { result: { passed: boolean }; report: { totals: { requests: number } } };
    expect(parsed.result.passed).toBe(true);
    expect(parsed.report.totals.requests).toBe(32);
  });

  it('gates on cost and churn thresholds', () => {
    const r = capture(runReplay, ['--max-newly-unroutable', '10', '--max-cost-increase-pct', '1']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('estimated cost increase');
    expect(capture(runReplay, ['--max-newly-unroutable', '10', '--max-changed-pct', '1']).code).toBe(1);
  });

  it('replaying the baseline against itself is clean', () => {
    const r = capture(runReplay, ['--candidate-policy', 'examples/policy.baseline.json']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('changed primary      0');
  });

  it('exits 2 for unusable input', () => {
    expect(capture(runReplay, ['--log', 'examples/nope.jsonl']).code).toBe(2);
    expect(capture(runReplay, ['--format', 'xml']).err).toContain('--format');
    expect(capture(runReplay, ['--max-changed-pct', 'many']).code).toBe(2);
    expect(capture(runReplay, ['--help']).out).toContain('Usage: replay');
  });
});
