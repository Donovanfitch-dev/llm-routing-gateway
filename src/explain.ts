/** Human-readable rendering of a routing decision. The JSON record remains the source of truth. */

import type { RequestDescriptor, RoutingDecision } from './types.js';

function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}

export function formatDecision(request: RequestDescriptor, decision: RoutingDecision): string {
  const lines: string[] = [];
  const caps = request.requiredCapabilities.length > 0 ? request.requiredCapabilities.join(',') : 'none';
  lines.push(`Request   ${request.id}  tenant=${request.tenantId}  task=${request.taskClass}`);
  lines.push(
    `          tokens in/out=${request.estimatedInputTokens}/${request.estimatedOutputTokens}  capabilities=${caps}` +
      `  region=${request.requiredRegion ?? 'any'}  max-latency=${request.maxLatencyClass ?? 'any'}` +
      `  max-cost=${request.maxCostUsd !== undefined ? usd(request.maxCostUsd) : 'none'}`,
  );
  const w = decision.effectiveWeights;
  lines.push(
    `Policy    ${decision.policy}  override=${decision.appliedOverride ?? 'none'}  weights cost=${w.cost} quality=${w.quality} latency=${w.latency}`,
  );
  if (decision.context.openProviders.length > 0) lines.push(`Breakers  open: ${decision.context.openProviders.join(', ')}`);
  lines.push(`Status    ${decision.status}${decision.reason ? `  [${decision.reason.code}] ${decision.reason.message}` : ''}`);

  if (decision.budget) {
    const b = decision.budget;
    lines.push(
      `Budget    ${b.outcome}  limit=${usd(b.limitUsd)} spent=${usd(b.spentUsd)} remaining=${usd(b.remainingUsd)} estimate=${usd(b.estimatedCostUsd)}` +
        (b.downgradedFrom ? `  downgraded from ${b.downgradedFrom}` : ''),
    );
    for (const x of b.excluded) {
      lines.push(`          excluded ${x.route} (est ${usd(x.estimatedCostUsd)} > remaining ${usd(b.remainingUsd)}) from primary and fallbacks [${x.code}]`);
    }
  }
  if (decision.primary) {
    lines.push(`Primary   ${decision.primary}`);
    lines.push(`Fallbacks ${decision.fallbacks.length > 0 ? decision.fallbacks.map((f, i) => `${i + 1}. ${f}`).join('  ') : '(none)'}`);
  }

  if (decision.ranking.length > 0) {
    lines.push('');
    lines.push('Ranking (score = weighted cost/quality/latency, 0..1)');
    for (const r of decision.ranking) {
      lines.push(
        `  #${r.rank}  ${r.route.padEnd(22)} score=${r.score.toFixed(4)}  cost=${r.components.cost.toFixed(2)} quality=${r.components.quality.toFixed(2)} latency=${r.components.latency.toFixed(2)}  est=${usd(r.estimatedCostUsd)}`,
      );
    }
  }

  const eliminated = decision.candidates.filter((c) => !c.eligible);
  if (eliminated.length > 0) {
    lines.push('');
    lines.push(`Eliminated (${eliminated.length} of ${decision.candidates.length})`);
    for (const c of eliminated) {
      lines.push(`  ${c.route}`);
      for (const e of c.eliminations) lines.push(`      ${e.code.padEnd(22)} ${e.detail}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
