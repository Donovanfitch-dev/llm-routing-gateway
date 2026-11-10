import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadCatalog, loadPolicy, validateCatalog, validatePolicy, validateRequest } from '../src/index.js';
import { baselinePolicy, candidatePolicy, exampleCatalog, examplePath, makeCatalog, makeModel } from './helpers.js';

function issuesOf(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('catalog validation', () => {
  it('accepts the bundled catalog', () => {
    expect(exampleCatalog().models.length).toBeGreaterThanOrEqual(6);
  });

  it('reports every problem with a path, not just the first', () => {
    const bad = {
      schemaVersion: 2,
      models: [
        { provider: 'Aurora', model: 'x', capabilities: { tools: 'yes' }, pricing: { inputPerMillionUsd: -1 }, latencyClass: 'warp', regions: [], qualityTier: 9 },
      ],
    };
    const issues = issuesOf(() => validateCatalog(bad));
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('$.schemaVersion'),
        expect.stringContaining('$.models[0].provider'),
        expect.stringContaining('$.models[0].capabilities.tools: must be a boolean'),
        expect.stringContaining('$.models[0].capabilities.vision: is required'),
        expect.stringContaining('$.models[0].pricing.inputPerMillionUsd: must be >= 0'),
        expect.stringContaining('$.models[0].latencyClass: must be one of fast, standard, slow'),
        expect.stringContaining('$.models[0].regions: must not be empty'),
        expect.stringContaining('$.models[0].qualityTier: must be <= 5'),
      ]),
    );
    expect(issues.length).toBeGreaterThanOrEqual(8);
  });

  it('rejects unknown keys, duplicates and empty catalogs', () => {
    const model = makeModel('aurora', 'aurora-x');
    expect(issuesOf(() => validateCatalog({ schemaVersion: 1, models: [] }))).toEqual([expect.stringContaining('at least one model')]);
    expect(issuesOf(() => validateCatalog({ schemaVersion: 1, models: [model, model] }))).toEqual([expect.stringContaining('duplicate route aurora/aurora-x')]);
    expect(issuesOf(() => validateCatalog({ schemaVersion: 1, models: [{ ...model, colour: 'red' }] }))).toEqual([expect.stringContaining('unknown key')]);
    expect(issuesOf(() => validateCatalog(null))).toEqual(['$: must be an object']);
  });

  it('rejects non-finite and fractional numbers', () => {
    const m = makeModel('aurora', 'aurora-x');
    const issues = issuesOf(() =>
      validateCatalog({ schemaVersion: 1, models: [{ ...m, qualityTier: 2.5, capabilities: { ...m.capabilities, maxContextTokens: 0 } }] }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([expect.stringContaining('qualityTier: must be an integer'), expect.stringContaining('maxContextTokens: must be > 0')]),
    );
  });
});

describe('policy validation', () => {
  it('accepts both bundled policies', () => {
    expect(baselinePolicy().name).toBe('baseline');
    expect(candidatePolicy().name).toBe('candidate-cost-saver');
  });

  it('applies defaults for optional sections', () => {
    const p = validatePolicy({ schemaVersion: 1, name: 'min', weights: { cost: 1, quality: 0, latency: 0 }, fallbackDepth: 1 });
    expect(p.deny).toEqual([]);
    expect(p.taskOverrides).toEqual({});
    expect(p.distinctProviderFallbacks).toBe(false);
    expect(p.budget).toBeUndefined();
  });

  it('collects multiple clear errors', () => {
    const issues = issuesOf(() =>
      validatePolicy({
        schemaVersion: 1,
        name: 'bad',
        weigths: {},
        weights: { cost: 0, quality: 0, latency: 0 },
        fallbackDepth: -1,
        deny: [{ id: 'd1', reason: 'r', match: {} }, { id: 'd1', reason: 'r', match: { provider: 'aurora' } }],
        taskOverrides: { chat: { minQualityTier: 7, weights: { cost: 1 } } },
        budget: { windowSeconds: 0, defaultLimitUsd: 1, onExceed: 'explode' },
        breaker: { failureThreshold: 0, openDurationMs: 10, halfOpenMaxProbes: 1 },
      }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('$.weigths: unknown key'),
        expect.stringContaining('$.weights: weights must not all be zero'),
        expect.stringContaining('$.fallbackDepth: must be >= 0'),
        expect.stringContaining('$.deny[0].match: must specify at least one field'),
        expect.stringContaining('$.deny[1].id: duplicate rule id "d1"'),
        expect.stringContaining('$.taskOverrides.chat.minQualityTier: must be <= 5'),
        expect.stringContaining('$.taskOverrides.chat.weights.quality: is required'),
        expect.stringContaining('$.budget.windowSeconds: must be > 0'),
        expect.stringContaining('$.budget.onExceed: must be one of reject, downgrade'),
        expect.stringContaining('$.breaker.failureThreshold: must be >= 1'),
      ]),
    );
  });

  it('cross-checks provider and model references against a catalog', () => {
    const catalog = makeCatalog(makeModel('aurora', 'aurora-x'));
    const doc = {
      schemaVersion: 1,
      name: 'refs',
      weights: { cost: 1, quality: 1, latency: 1 },
      fallbackDepth: 1,
      deny: [{ id: 'd', reason: 'r', match: { provider: 'boreal' } }, { id: 'e', reason: 'r', match: { model: 'ghost' } }],
      taskOverrides: { chat: { allowProviders: ['cirrus'] } },
    };
    expect(() => validatePolicy(doc)).not.toThrow();
    const issues = issuesOf(() => validatePolicy(doc, catalog));
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('unknown provider "boreal"'),
        expect.stringContaining('unknown model "ghost"'),
        expect.stringContaining('allowProviders[0]: unknown provider "cirrus"'),
      ]),
    );
  });
});

describe('request validation', () => {
  it('accepts a minimal request and normalises capabilities', () => {
    const r = validateRequest({ id: 'a', tenantId: 't', taskClass: 'chat', estimatedInputTokens: 1, estimatedOutputTokens: 1, requiredCapabilities: ['tools', 'tools'] });
    expect(r.requiredCapabilities).toEqual(['tools']);
  });

  it('rejects bad fields', () => {
    const issues = issuesOf(() =>
      validateRequest({ id: '', tenantId: 't', taskClass: 'chat', estimatedInputTokens: -5, estimatedOutputTokens: 1.5, requiredCapabilities: ['telepathy'], maxLatencyClass: 'instant' }),
    );
    expect(issues.length).toBe(5);
  });
});

describe('file loading', () => {
  it('names the file and reports invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routing-gateway-'));
    const file = join(dir, 'broken.json');
    writeFileSync(file, '{ "schemaVersion": 1, ', 'utf8');
    expect(() => loadCatalog(file)).toThrow(/Catalog file .*broken\.json is invalid[\s\S]*not valid JSON/);
  });

  it('names the file and the issues for invalid content, and for missing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routing-gateway-'));
    const file = join(dir, 'policy.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: 'x', weights: {}, fallbackDepth: 1 }), 'utf8');
    expect(() => loadPolicy(file)).toThrow(/Policy file .*policy\.json is invalid \(3 problems\)/);
    expect(() => loadCatalog(join(dir, 'missing.json'))).toThrow(/cannot be read/);
  });

  it('loads the bundled files', () => {
    expect(loadCatalog(examplePath('catalog.json')).models.length).toBe(8);
  });
});
