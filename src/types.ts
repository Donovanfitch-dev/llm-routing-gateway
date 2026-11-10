/**
 * Core data types. Everything the router consumes (catalog, policy, request)
 * and produces (decision, outcome, log record) is plain JSON-serialisable data.
 */

export const LATENCY_CLASSES = ['fast', 'standard', 'slow'] as const;
export type LatencyClass = (typeof LATENCY_CLASSES)[number];

export const CAPABILITIES = ['tools', 'vision', 'jsonOutput'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Quality tiers are integers in [1, QUALITY_TIER_MAX]; higher is better. */
export const QUALITY_TIER_MAX = 5;

/** A route is a catalog entry, identified as `provider/model`. */
export type RouteId = string;

// ---------------------------------------------------------------- catalog

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  jsonOutput: boolean;
  maxContextTokens: number;
}

export interface ModelPricing {
  /** Fictional USD price per one million input tokens. */
  inputPerMillionUsd: number;
  /** Fictional USD price per one million output tokens. */
  outputPerMillionUsd: number;
}

export interface ModelEntry {
  provider: string;
  model: string;
  capabilities: ModelCapabilities;
  pricing: ModelPricing;
  latencyClass: LatencyClass;
  regions: string[];
  qualityTier: number;
}

export interface Catalog {
  schemaVersion: 1;
  notice?: string;
  models: ModelEntry[];
}

// ---------------------------------------------------------------- request

export interface RequestDescriptor {
  id: string;
  tenantId: string;
  taskClass: string;
  requiredCapabilities: Capability[];
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  /** Hard ceiling on the estimated cost of a single request, in USD. */
  maxCostUsd?: number;
  /** Slowest acceptable latency class. */
  maxLatencyClass?: LatencyClass;
  requiredRegion?: string;
}

// ----------------------------------------------------------------- policy

export interface Weights {
  cost: number;
  quality: number;
  latency: number;
}

export interface DenyMatch {
  provider?: string;
  model?: string;
  tenantId?: string;
  taskClass?: string;
}

export interface DenyRule {
  id: string;
  reason: string;
  /** All specified fields must match for the rule to fire. */
  match: DenyMatch;
}

export interface TaskOverride {
  weights?: Weights;
  minQualityTier?: number;
  allowProviders?: string[];
  fallbackDepth?: number;
}

export type BudgetAction = 'reject' | 'downgrade';

export interface BudgetPolicy {
  windowSeconds: number;
  defaultLimitUsd: number;
  tenantLimitsUsd: Record<string, number>;
  onExceed: BudgetAction;
}

export interface BreakerPolicy {
  failureThreshold: number;
  openDurationMs: number;
  halfOpenMaxProbes: number;
}

export interface RoutingPolicy {
  schemaVersion: 1;
  name: string;
  description?: string;
  weights: Weights;
  fallbackDepth: number;
  distinctProviderFallbacks: boolean;
  deny: DenyRule[];
  taskOverrides: Record<string, TaskOverride>;
  budget?: BudgetPolicy;
  breaker?: BreakerPolicy;
}

// --------------------------------------------------------------- decision

export const ELIMINATION_CODES = [
  'DENY_RULE',
  'PROVIDER_NOT_ALLOWED',
  'MISSING_CAPABILITY',
  'CONTEXT_EXCEEDED',
  'REGION_MISMATCH',
  'LATENCY_EXCEEDS_LIMIT',
  'QUALITY_BELOW_MINIMUM',
  'COST_EXCEEDS_LIMIT',
  'CIRCUIT_OPEN',
] as const;
export type EliminationCode = (typeof ELIMINATION_CODES)[number];

export interface Elimination {
  code: EliminationCode;
  detail: string;
}

export interface CandidateEvaluation {
  route: RouteId;
  provider: string;
  model: string;
  estimatedCostUsd: number;
  eligible: boolean;
  eliminations: Elimination[];
}

export interface ScoreComponents {
  cost: number;
  quality: number;
  latency: number;
}

export interface RankedCandidate {
  rank: number;
  route: RouteId;
  score: number;
  components: ScoreComponents;
  estimatedCostUsd: number;
}

export interface BudgetSnapshot {
  limitUsd: number;
  spentUsd: number;
  windowStartMs: number;
  windowEndMs: number;
}

export type BudgetOutcome = 'within_budget' | 'downgraded' | 'rejected';

export interface BudgetDecision {
  outcome: BudgetOutcome;
  limitUsd: number;
  spentUsd: number;
  remainingUsd: number;
  estimatedCostUsd: number;
  /** Set when the budget changed the primary route. */
  downgradedFrom: RouteId | null;
  /** Ranked routes dropped because their estimate exceeded the remaining budget. */
  excludedRoutes: RouteId[];
}

export type DecisionStatus = 'routed' | 'unroutable' | 'rejected';

export interface DecisionReason {
  code: 'NO_ELIGIBLE_CANDIDATE' | 'BUDGET_EXCEEDED';
  message: string;
}

export interface RoutingContext {
  /** Providers whose circuit breaker is open when the decision is made. */
  openProviders?: readonly string[];
  /** Budget window state for the request's tenant, when budgets are active. */
  budget?: BudgetSnapshot;
}

export interface RoutingDecision {
  schemaVersion: 1;
  requestId: string;
  policy: string;
  appliedOverride: string | null;
  effectiveWeights: Weights;
  status: DecisionStatus;
  reason: DecisionReason | null;
  primary: RouteId | null;
  fallbacks: RouteId[];
  context: { openProviders: string[]; budget: BudgetSnapshot | null };
  candidates: CandidateEvaluation[];
  ranking: RankedCandidate[];
  budget: BudgetDecision | null;
}

// -------------------------------------------------------------- execution

export type AttemptStatus = 'ok' | 'error' | 'timeout' | 'skipped';

export interface Attempt {
  route: RouteId;
  status: AttemptStatus;
  errorCode: string | null;
  retryable: boolean | null;
  skipReason: 'CIRCUIT_OPEN' | 'NO_ADAPTER' | null;
}

export type OutcomeStatus = 'success' | 'failed' | 'exhausted' | 'not_executed';

export interface Outcome {
  status: OutcomeStatus;
  servedBy: RouteId | null;
  attempts: Attempt[];
  usage: { inputTokens: number; outputTokens: number } | null;
  actualCostUsd: number | null;
}

export interface LogRecord {
  schemaVersion: 1;
  timestamp: string;
  request: RequestDescriptor;
  decision: RoutingDecision;
  outcome: Outcome;
}
