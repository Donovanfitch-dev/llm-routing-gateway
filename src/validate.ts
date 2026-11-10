/**
 * Custom validators (no schema library) for catalog, policy and request documents.
 *
 * Validators never stop at the first problem: they collect every issue with a
 * JSON-path style location so a bad file can be fixed in one pass. Unknown
 * keys are rejected to catch typos (`"weigths"`) early.
 */

import {
  CAPABILITIES,
  LATENCY_CLASSES,
  QUALITY_TIER_MAX,
  type BreakerPolicy,
  type BudgetAction,
  type BudgetPolicy,
  type Capability,
  type Catalog,
  type DenyRule,
  type LatencyClass,
  type ModelEntry,
  type RequestDescriptor,
  type RoutingPolicy,
  type TaskOverride,
  type Weights,
} from './types.js';
import { dictionary, routeId } from './util.js';

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(subject: string, issues: readonly string[]) {
    const noun = issues.length === 1 ? 'problem' : 'problems';
    super(`${subject} is invalid (${issues.length} ${noun}):\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const IDENTIFIER = /^[a-z][a-z0-9-]*$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface NumberRules {
  min?: number;
  max?: number;
  integer?: boolean;
  exclusiveMin?: number;
}

class Checker {
  readonly issues: string[] = [];

  add(path: string, message: string): void {
    this.issues.push(`${path}: ${message}`);
  }

  record(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> | undefined {
    if (!isRecord(value)) {
      this.add(path, 'must be an object');
      return undefined;
    }
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) this.add(`${path}.${key}`, `unknown key (allowed: ${allowed.join(', ')})`);
    }
    return value;
  }

  string(value: unknown, path: string, pattern?: { re: RegExp; hint: string }): string | undefined {
    if (value === undefined) {
      this.add(path, 'is required');
      return undefined;
    }
    if (typeof value !== 'string' || value.length === 0) {
      this.add(path, 'must be a non-empty string');
      return undefined;
    }
    if (pattern && !pattern.re.test(value)) {
      this.add(path, `${JSON.stringify(value)} is not valid (${pattern.hint})`);
      return undefined;
    }
    return value;
  }

  number(value: unknown, path: string, rules: NumberRules = {}): number | undefined {
    if (value === undefined) {
      this.add(path, 'is required');
      return undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.add(path, 'must be a finite number');
      return undefined;
    }
    if (rules.integer === true && !Number.isInteger(value)) {
      this.add(path, `must be an integer, got ${value}`);
      return undefined;
    }
    if (rules.min !== undefined && value < rules.min) {
      this.add(path, `must be >= ${rules.min}, got ${value}`);
      return undefined;
    }
    if (rules.exclusiveMin !== undefined && value <= rules.exclusiveMin) {
      this.add(path, `must be > ${rules.exclusiveMin}, got ${value}`);
      return undefined;
    }
    if (rules.max !== undefined && value > rules.max) {
      this.add(path, `must be <= ${rules.max}, got ${value}`);
      return undefined;
    }
    return value;
  }

  boolean(value: unknown, path: string): boolean | undefined {
    if (value === undefined) {
      this.add(path, 'is required');
      return undefined;
    }
    if (typeof value !== 'boolean') {
      this.add(path, 'must be a boolean');
      return undefined;
    }
    return value;
  }

  oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T | undefined {
    if (value === undefined) {
      this.add(path, 'is required');
      return undefined;
    }
    const found = options.find((o) => o === value);
    if (found === undefined) {
      this.add(path, `must be one of ${options.join(', ')}; got ${JSON.stringify(value)}`);
    }
    return found;
  }

  array(value: unknown, path: string): unknown[] | undefined {
    if (value === undefined) {
      this.add(path, 'is required');
      return undefined;
    }
    if (!Array.isArray(value)) {
      this.add(path, 'must be an array');
      return undefined;
    }
    return value as unknown[];
  }

  stringArray(value: unknown, path: string, opts: { nonEmpty?: boolean; pattern?: { re: RegExp; hint: string } } = {}): string[] | undefined {
    const arr = this.array(value, path);
    if (!arr) return undefined;
    if (opts.nonEmpty === true && arr.length === 0) this.add(path, 'must not be empty');
    const out: string[] = [];
    arr.forEach((item, i) => {
      const s = this.string(item, `${path}[${i}]`, opts.pattern);
      if (s !== undefined) out.push(s);
    });
    return out;
  }
}

const IDENT_PATTERN = { re: IDENTIFIER, hint: 'lowercase letters, digits and hyphens, starting with a letter' };
const NAME_PATTERN = { re: NAME, hint: 'letters, digits, ".", "_" or "-", starting with a letter or digit' };

function parseWeights(c: Checker, value: unknown, path: string): Weights | undefined {
  const obj = c.record(value, path, ['cost', 'quality', 'latency']);
  if (!obj) return undefined;
  const cost = c.number(obj['cost'], `${path}.cost`, { min: 0 });
  const quality = c.number(obj['quality'], `${path}.quality`, { min: 0 });
  const latency = c.number(obj['latency'], `${path}.latency`, { min: 0 });
  if (cost === undefined || quality === undefined || latency === undefined) return undefined;
  if (cost + quality + latency <= 0) {
    c.add(path, 'weights must not all be zero');
    return undefined;
  }
  return { cost, quality, latency };
}

// ---------------------------------------------------------------- catalog

export function validateCatalog(raw: unknown): Catalog {
  const c = new Checker();
  const root = c.record(raw, '$', ['schemaVersion', 'notice', 'models']);
  const models: ModelEntry[] = [];
  if (root) {
    if (root['schemaVersion'] !== 1) c.add('$.schemaVersion', 'must be 1');
    if (root['notice'] !== undefined && typeof root['notice'] !== 'string') c.add('$.notice', 'must be a string');
    const list = c.array(root['models'], '$.models');
    if (list) {
      if (list.length === 0) c.add('$.models', 'must contain at least one model');
      const seen = new Set<string>();
      list.forEach((item, i) => {
        const entry = parseModel(c, item, `$.models[${i}]`);
        if (!entry) return;
        const id = routeId(entry.provider, entry.model);
        if (seen.has(id)) c.add(`$.models[${i}]`, `duplicate route ${id}`);
        seen.add(id);
        models.push(entry);
      });
    }
  }
  if (c.issues.length > 0) throw new ConfigError('Catalog', c.issues);
  const catalog: Catalog = { schemaVersion: 1, models };
  if (typeof root?.['notice'] === 'string') catalog.notice = root['notice'];
  return catalog;
}

function parseModel(c: Checker, value: unknown, path: string): ModelEntry | undefined {
  const obj = c.record(value, path, ['provider', 'model', 'capabilities', 'pricing', 'latencyClass', 'regions', 'qualityTier']);
  if (!obj) return undefined;
  const provider = c.string(obj['provider'], `${path}.provider`, IDENT_PATTERN);
  const model = c.string(obj['model'], `${path}.model`, IDENT_PATTERN);

  const capObj = c.record(obj['capabilities'], `${path}.capabilities`, ['tools', 'vision', 'jsonOutput', 'maxContextTokens']);
  const tools = capObj ? c.boolean(capObj['tools'], `${path}.capabilities.tools`) : undefined;
  const vision = capObj ? c.boolean(capObj['vision'], `${path}.capabilities.vision`) : undefined;
  const jsonOutput = capObj ? c.boolean(capObj['jsonOutput'], `${path}.capabilities.jsonOutput`) : undefined;
  const maxContextTokens = capObj
    ? c.number(capObj['maxContextTokens'], `${path}.capabilities.maxContextTokens`, { integer: true, exclusiveMin: 0 })
    : undefined;

  const priceObj = c.record(obj['pricing'], `${path}.pricing`, ['inputPerMillionUsd', 'outputPerMillionUsd']);
  const inputPrice = priceObj ? c.number(priceObj['inputPerMillionUsd'], `${path}.pricing.inputPerMillionUsd`, { min: 0 }) : undefined;
  const outputPrice = priceObj ? c.number(priceObj['outputPerMillionUsd'], `${path}.pricing.outputPerMillionUsd`, { min: 0 }) : undefined;

  const latencyClass = c.oneOf(obj['latencyClass'], `${path}.latencyClass`, LATENCY_CLASSES);
  const regions = c.stringArray(obj['regions'], `${path}.regions`, { nonEmpty: true, pattern: IDENT_PATTERN });
  const qualityTier = c.number(obj['qualityTier'], `${path}.qualityTier`, { integer: true, min: 1, max: QUALITY_TIER_MAX });

  if (
    provider === undefined || model === undefined || tools === undefined || vision === undefined ||
    jsonOutput === undefined || maxContextTokens === undefined || inputPrice === undefined ||
    outputPrice === undefined || latencyClass === undefined || regions === undefined || qualityTier === undefined
  ) {
    return undefined;
  }
  return {
    provider,
    model,
    capabilities: { tools, vision, jsonOutput, maxContextTokens },
    pricing: { inputPerMillionUsd: inputPrice, outputPerMillionUsd: outputPrice },
    latencyClass,
    regions,
    qualityTier,
  };
}

// ----------------------------------------------------------------- policy

const POLICY_KEYS = [
  'schemaVersion', 'name', 'description', 'weights', 'fallbackDepth', 'distinctProviderFallbacks',
  'deny', 'taskOverrides', 'budget', 'breaker',
] as const;

/**
 * Validate a policy document. When a catalog is supplied, provider and model
 * names referenced by deny rules and task overrides must exist in it, which
 * catches typos that would otherwise silently match nothing.
 */
export function validatePolicy(raw: unknown, catalog?: Catalog): RoutingPolicy {
  const c = new Checker();
  const root = c.record(raw, '$', POLICY_KEYS);
  const providers = new Set(catalog?.models.map((m) => m.provider));
  const modelIds = new Set(catalog?.models.map((m) => m.model));
  let policy: RoutingPolicy | undefined;

  if (root) {
    if (root['schemaVersion'] !== 1) c.add('$.schemaVersion', 'must be 1');
    const name = c.string(root['name'], '$.name', NAME_PATTERN);
    if (root['description'] !== undefined && typeof root['description'] !== 'string') c.add('$.description', 'must be a string');
    const weights = parseWeights(c, root['weights'], '$.weights');
    const fallbackDepth = c.number(root['fallbackDepth'], '$.fallbackDepth', { integer: true, min: 0, max: 10 });
    let distinct = false;
    if (root['distinctProviderFallbacks'] !== undefined) distinct = c.boolean(root['distinctProviderFallbacks'], '$.distinctProviderFallbacks') ?? false;

    const deny: DenyRule[] = [];
    if (root['deny'] !== undefined) {
      const list = c.array(root['deny'], '$.deny');
      const seen = new Set<string>();
      list?.forEach((item, i) => {
        const rule = parseDenyRule(c, item, `$.deny[${i}]`, catalog ? { providers, modelIds } : undefined);
        if (!rule) return;
        if (seen.has(rule.id)) c.add(`$.deny[${i}].id`, `duplicate rule id ${JSON.stringify(rule.id)}`);
        seen.add(rule.id);
        deny.push(rule);
      });
    }

    const overrides = dictionary<TaskOverride>();
    if (root['taskOverrides'] !== undefined) {
      const obj = c.record(root['taskOverrides'], '$.taskOverrides', Object.keys(isRecord(root['taskOverrides']) ? root['taskOverrides'] : {}));
      if (obj) {
        for (const [taskClass, value] of Object.entries(obj)) {
          if (!NAME.test(taskClass)) c.add(`$.taskOverrides.${taskClass}`, 'task class name is not valid');
          const o = parseOverride(c, value, `$.taskOverrides.${taskClass}`, catalog ? providers : undefined);
          if (o) overrides[taskClass] = o;
        }
      }
    }

    const budget = root['budget'] !== undefined ? parseBudget(c, root['budget'], '$.budget') : undefined;
    const breaker = root['breaker'] !== undefined ? parseBreaker(c, root['breaker'], '$.breaker') : undefined;

    if (name !== undefined && weights !== undefined && fallbackDepth !== undefined) {
      policy = {
        schemaVersion: 1,
        name,
        weights,
        fallbackDepth,
        distinctProviderFallbacks: distinct,
        deny,
        taskOverrides: overrides,
      };
      if (typeof root['description'] === 'string') policy.description = root['description'];
      if (budget) policy.budget = budget;
      if (breaker) policy.breaker = breaker;
    }
  }
  if (c.issues.length > 0 || !policy) throw new ConfigError('Policy', c.issues);
  return policy;
}

function parseDenyRule(
  c: Checker,
  value: unknown,
  path: string,
  refs?: { providers: Set<string>; modelIds: Set<string> },
): DenyRule | undefined {
  const obj = c.record(value, path, ['id', 'reason', 'match']);
  if (!obj) return undefined;
  const id = c.string(obj['id'], `${path}.id`, NAME_PATTERN);
  const reason = c.string(obj['reason'], `${path}.reason`);
  const matchObj = c.record(obj['match'], `${path}.match`, ['provider', 'model', 'tenantId', 'taskClass']);
  const match: DenyRule['match'] = {};
  if (matchObj) {
    if (Object.keys(matchObj).length === 0) c.add(`${path}.match`, 'must specify at least one field');
    for (const key of ['provider', 'model', 'tenantId', 'taskClass'] as const) {
      if (matchObj[key] === undefined) continue;
      const s = c.string(matchObj[key], `${path}.match.${key}`);
      if (s !== undefined) match[key] = s;
    }
    if (refs && match.provider !== undefined && !refs.providers.has(match.provider)) {
      c.add(`${path}.match.provider`, `unknown provider ${JSON.stringify(match.provider)} (not in catalog)`);
    }
    if (refs && match.model !== undefined && !refs.modelIds.has(match.model)) {
      c.add(`${path}.match.model`, `unknown model ${JSON.stringify(match.model)} (not in catalog)`);
    }
  }
  if (id === undefined || reason === undefined || !matchObj) return undefined;
  return { id, reason, match };
}

function parseOverride(c: Checker, value: unknown, path: string, providers?: Set<string>): TaskOverride | undefined {
  const obj = c.record(value, path, ['weights', 'minQualityTier', 'allowProviders', 'fallbackDepth']);
  if (!obj) return undefined;
  const out: TaskOverride = {};
  if (obj['weights'] !== undefined) {
    const w = parseWeights(c, obj['weights'], `${path}.weights`);
    if (w) out.weights = w;
  }
  if (obj['minQualityTier'] !== undefined) {
    const q = c.number(obj['minQualityTier'], `${path}.minQualityTier`, { integer: true, min: 1, max: QUALITY_TIER_MAX });
    if (q !== undefined) out.minQualityTier = q;
  }
  if (obj['allowProviders'] !== undefined) {
    const list = c.stringArray(obj['allowProviders'], `${path}.allowProviders`, { nonEmpty: true });
    if (list) {
      out.allowProviders = list;
      if (providers) {
        list.forEach((p, i) => {
          if (!providers.has(p)) c.add(`${path}.allowProviders[${i}]`, `unknown provider ${JSON.stringify(p)} (not in catalog)`);
        });
      }
    }
  }
  if (obj['fallbackDepth'] !== undefined) {
    const d = c.number(obj['fallbackDepth'], `${path}.fallbackDepth`, { integer: true, min: 0, max: 10 });
    if (d !== undefined) out.fallbackDepth = d;
  }
  return out;
}

function parseBudget(c: Checker, value: unknown, path: string): BudgetPolicy | undefined {
  const obj = c.record(value, path, ['windowSeconds', 'defaultLimitUsd', 'tenantLimitsUsd', 'onExceed']);
  if (!obj) return undefined;
  const windowSeconds = c.number(obj['windowSeconds'], `${path}.windowSeconds`, { integer: true, exclusiveMin: 0 });
  const defaultLimitUsd = c.number(obj['defaultLimitUsd'], `${path}.defaultLimitUsd`, { min: 0 });
  const onExceed: BudgetAction | undefined = c.oneOf(obj['onExceed'], `${path}.onExceed`, ['reject', 'downgrade'] as const);
  const tenantLimitsUsd = dictionary<number>();
  if (obj['tenantLimitsUsd'] !== undefined) {
    const limits = c.record(obj['tenantLimitsUsd'], `${path}.tenantLimitsUsd`, Object.keys(isRecord(obj['tenantLimitsUsd']) ? obj['tenantLimitsUsd'] : {}));
    if (limits) {
      for (const [tenant, v] of Object.entries(limits)) {
        if (!NAME.test(tenant)) c.add(`${path}.tenantLimitsUsd.${tenant}`, 'tenant id is not valid');
        const n = c.number(v, `${path}.tenantLimitsUsd.${tenant}`, { min: 0 });
        if (n !== undefined) tenantLimitsUsd[tenant] = n;
      }
    }
  }
  if (windowSeconds === undefined || defaultLimitUsd === undefined || onExceed === undefined) return undefined;
  return { windowSeconds, defaultLimitUsd, tenantLimitsUsd, onExceed };
}

function parseBreaker(c: Checker, value: unknown, path: string): BreakerPolicy | undefined {
  const obj = c.record(value, path, ['failureThreshold', 'openDurationMs', 'halfOpenMaxProbes']);
  if (!obj) return undefined;
  const failureThreshold = c.number(obj['failureThreshold'], `${path}.failureThreshold`, { integer: true, min: 1 });
  const openDurationMs = c.number(obj['openDurationMs'], `${path}.openDurationMs`, { integer: true, exclusiveMin: 0 });
  const halfOpenMaxProbes = c.number(obj['halfOpenMaxProbes'], `${path}.halfOpenMaxProbes`, { integer: true, min: 1 });
  if (failureThreshold === undefined || openDurationMs === undefined || halfOpenMaxProbes === undefined) return undefined;
  return { failureThreshold, openDurationMs, halfOpenMaxProbes };
}

// ---------------------------------------------------------------- request

const REQUEST_KEYS = [
  'id', 'tenantId', 'taskClass', 'requiredCapabilities', 'estimatedInputTokens', 'estimatedOutputTokens',
  'maxCostUsd', 'maxLatencyClass', 'requiredRegion',
] as const;

/** Validate a request descriptor. `subject` is used in the error header (e.g. a log line). */
export function validateRequest(raw: unknown, subject = 'Request'): RequestDescriptor {
  const c = new Checker();
  const request = parseRequest(c, raw, '$');
  if (c.issues.length > 0 || !request) throw new ConfigError(subject, c.issues);
  return request;
}

export function parseRequest(c: Checker, raw: unknown, path: string): RequestDescriptor | undefined {
  const obj = c.record(raw, path, REQUEST_KEYS);
  if (!obj) return undefined;
  const id = c.string(obj['id'], `${path}.id`, NAME_PATTERN);
  const tenantId = c.string(obj['tenantId'], `${path}.tenantId`, NAME_PATTERN);
  const taskClass = c.string(obj['taskClass'], `${path}.taskClass`, NAME_PATTERN);
  const caps: Capability[] = [];
  if (obj['requiredCapabilities'] !== undefined) {
    const list = c.array(obj['requiredCapabilities'], `${path}.requiredCapabilities`);
    list?.forEach((item, i) => {
      const cap = c.oneOf(item, `${path}.requiredCapabilities[${i}]`, CAPABILITIES);
      if (cap !== undefined && !caps.includes(cap)) caps.push(cap);
    });
  }
  const inTok = c.number(obj['estimatedInputTokens'], `${path}.estimatedInputTokens`, { integer: true, min: 0 });
  const outTok = c.number(obj['estimatedOutputTokens'], `${path}.estimatedOutputTokens`, { integer: true, min: 0 });
  const maxCostUsd = obj['maxCostUsd'] !== undefined ? c.number(obj['maxCostUsd'], `${path}.maxCostUsd`, { min: 0 }) : undefined;
  const maxLatencyClass: LatencyClass | undefined =
    obj['maxLatencyClass'] !== undefined ? c.oneOf(obj['maxLatencyClass'], `${path}.maxLatencyClass`, LATENCY_CLASSES) : undefined;
  const requiredRegion = obj['requiredRegion'] !== undefined ? c.string(obj['requiredRegion'], `${path}.requiredRegion`, IDENT_PATTERN) : undefined;

  if (id === undefined || tenantId === undefined || taskClass === undefined || inTok === undefined || outTok === undefined) {
    return undefined;
  }
  const request: RequestDescriptor = {
    id,
    tenantId,
    taskClass,
    requiredCapabilities: caps,
    estimatedInputTokens: inTok,
    estimatedOutputTokens: outTok,
  };
  if (maxCostUsd !== undefined) request.maxCostUsd = maxCostUsd;
  if (maxLatencyClass !== undefined) request.maxLatencyClass = maxLatencyClass;
  if (requiredRegion !== undefined) request.requiredRegion = requiredRegion;
  return request;
}

export { Checker };
