#!/usr/bin/env node
/** `route`: route one request against a catalog and policy and print the explanation. Never executes anything. */

import { parseArgs } from 'node:util';
import { BudgetTracker } from '../budget.js';
import { formatDecision } from '../explain.js';
import { loadCatalog, loadPolicy, loadRequest } from '../load.js';
import { routeRequest } from '../router.js';
import type { RequestDescriptor } from '../types.js';
import { validateRequest } from '../validate.js';
import { bundled, guarded, isEntryPoint, parseNumberFlag, processIO, UsageError, type IO } from './common.js';

const HELP = `Usage: route [options]

Routes one request and prints why each model was kept or eliminated.
With no request options, routes the bundled examples/sample-request.json.

Request (either --request <file> or the flags below):
  --request <file>      JSON request descriptor
  --id <id>             request id (default: cli-request)
  --tenant <id>         tenant id (default: tenant-alpha)
  --task <class>        task class (default: summarize)
  --in <tokens>         estimated input tokens (default: 1000)
  --out <tokens>        estimated output tokens (default: 200)
  --capability <name>   required capability: tools | vision | jsonOutput (repeatable)
  --region <region>     required data region
  --max-latency <cls>   slowest acceptable latency class: fast | standard | slow
  --max-cost <usd>      maximum estimated cost for the request

Environment:
  --catalog <file>      model catalog (default: examples/catalog.json)
  --policy <file>       routing policy (default: examples/policy.baseline.json)
  --open-provider <p>   treat provider p's circuit breaker as open (repeatable)
  --spent <usd>         pretend the tenant has already spent this much in the budget window

Output:
  --json                print the full decision record as JSON
  -h, --help            show this help
`;

export function runRoute(argv: readonly string[], io: IO = processIO): number {
  return guarded(io, () => {
    let parsed;
    try {
      parsed = parseArgs({
        args: [...argv],
        options: {
          request: { type: 'string' },
          id: { type: 'string' },
          tenant: { type: 'string' },
          task: { type: 'string' },
          in: { type: 'string' },
          out: { type: 'string' },
          capability: { type: 'string', multiple: true },
          region: { type: 'string' },
          'max-latency': { type: 'string' },
          'max-cost': { type: 'string' },
          catalog: { type: 'string' },
          policy: { type: 'string' },
          'open-provider': { type: 'string', multiple: true },
          spent: { type: 'string' },
          json: { type: 'boolean' },
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

    const catalog = loadCatalog(v.catalog ?? bundled('examples/catalog.json'));
    const policy = loadPolicy(v.policy ?? bundled('examples/policy.baseline.json'), catalog);

    const flagRequest = [v.id, v.tenant, v.task, v.in, v.out, v.capability, v.region, v['max-latency'], v['max-cost']].some((x) => x !== undefined);
    if (v.request !== undefined && flagRequest) throw new UsageError('use either --request <file> or request flags, not both');

    let request: RequestDescriptor;
    if (v.request !== undefined) {
      request = loadRequest(v.request);
    } else if (flagRequest) {
      const draft: Record<string, unknown> = {
        id: v.id ?? 'cli-request',
        tenantId: v.tenant ?? 'tenant-alpha',
        taskClass: v.task ?? 'summarize',
        requiredCapabilities: v.capability ?? [],
        estimatedInputTokens: parseNumberFlag('in', v.in) ?? 1000,
        estimatedOutputTokens: parseNumberFlag('out', v.out) ?? 200,
      };
      const maxCost = parseNumberFlag('max-cost', v['max-cost']);
      if (maxCost !== undefined) draft['maxCostUsd'] = maxCost;
      if (v['max-latency'] !== undefined) draft['maxLatencyClass'] = v['max-latency'];
      if (v.region !== undefined) draft['requiredRegion'] = v.region;
      request = validateRequest(draft, 'Request flags');
    } else {
      request = loadRequest(bundled('examples/sample-request.json'));
    }

    let budget;
    if (policy.budget) {
      const tracker = new BudgetTracker(policy.budget, () => 0);
      const spent = parseNumberFlag('spent', v.spent, 0);
      if (spent !== undefined) tracker.record(request.tenantId, spent);
      budget = tracker.snapshot(request.tenantId);
    }

    const decision = routeRequest(request, policy, catalog, {
      openProviders: v['open-provider'] ?? [],
      ...(budget ? { budget } : {}),
    });

    io.out(v.json ? `${JSON.stringify({ request, decision }, null, 2)}\n` : formatDecision(request, decision));
    return decision.status === 'routed' ? 0 : 1;
  });
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = runRoute(process.argv.slice(2));
}
