#!/usr/bin/env node
/**
 * `replay`: re-route a recorded decision log against a candidate policy and
 * print a diff. Exit codes: 0 = within thresholds, 1 = a threshold was
 * exceeded, 2 = bad input.
 */

import { parseArgs } from 'node:util';
import { loadCatalog, loadPolicy } from '../load.js';
import { readLog } from '../log.js';
import { evaluateThresholds, formatReport, replay, type ReplayThresholds } from '../replay.js';
import { bundled, guarded, isEntryPoint, parseNumberFlag, processIO, UsageError, type IO } from './common.js';

const HELP = `Usage: replay [options]

Re-routes every request in a recorded JSONL log against a candidate policy
(and optionally a candidate catalog) WITHOUT executing anything, then prints
what would change. Exits 1 when a threshold is exceeded.

Inputs (defaults are the bundled examples):
  --log <file>                 recorded decision log (examples/requests.sample.jsonl)
  --candidate-policy <file>    policy to evaluate (examples/policy.candidate.json)
  --candidate-catalog <file>   catalog to evaluate against (examples/catalog.json)
  --no-budget-sim              do not re-simulate tenant budgets

Thresholds (CI gate):
  --max-newly-unroutable <n>   default 0
  --max-changed-pct <pct>      max share of requests whose primary route changes
  --max-cost-increase-pct <pct>
  --max-cost-increase-usd <usd>

Output:
  --format <text|json>         default text
  -h, --help
`;

export function runReplay(argv: readonly string[], io: IO = processIO): number {
  return guarded(io, () => {
    let parsed;
    try {
      parsed = parseArgs({
        args: [...argv],
        options: {
          log: { type: 'string' },
          'candidate-policy': { type: 'string' },
          'candidate-catalog': { type: 'string' },
          'no-budget-sim': { type: 'boolean' },
          'max-newly-unroutable': { type: 'string' },
          'max-changed-pct': { type: 'string' },
          'max-cost-increase-pct': { type: 'string' },
          'max-cost-increase-usd': { type: 'string' },
          format: { type: 'string' },
          help: { type: 'boolean', short: 'h' },
        },
        allowPositionals: false,
      });
    } catch (error) {
      throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    }
    const v = parsed.values;
    if (v.help) {
      io.out(HELP);
      return 0;
    }
    const format = v.format ?? 'text';
    if (format !== 'text' && format !== 'json') throw new UsageError(`--format must be "text" or "json", got ${JSON.stringify(format)}`);

    const catalog = loadCatalog(v['candidate-catalog'] ?? bundled('examples/catalog.json'));
    const policy = loadPolicy(v['candidate-policy'] ?? bundled('examples/policy.candidate.json'), catalog);
    const records = readLog(v.log ?? bundled('examples/requests.sample.jsonl'));

    const thresholds: ReplayThresholds = { maxNewlyUnroutable: parseNumberFlag('max-newly-unroutable', v['max-newly-unroutable']) ?? 0 };
    const pct = parseNumberFlag('max-changed-pct', v['max-changed-pct']);
    const costPct = parseNumberFlag('max-cost-increase-pct', v['max-cost-increase-pct']);
    const costUsd = parseNumberFlag('max-cost-increase-usd', v['max-cost-increase-usd']);
    if (pct !== undefined) thresholds.maxChangedPrimaryPct = pct;
    if (costPct !== undefined) thresholds.maxCostIncreasePct = costPct;
    if (costUsd !== undefined) thresholds.maxCostIncreaseUsd = costUsd;

    const report = replay(records, policy, catalog, { simulateBudgets: v['no-budget-sim'] !== true });
    const result = evaluateThresholds(report, thresholds);

    io.out(format === 'json' ? `${JSON.stringify({ report, thresholds, result }, null, 2)}\n` : formatReport(report, result, thresholds));
    return result.passed ? 0 : 1;
  });
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = runReplay(process.argv.slice(2));
}
