import { fileURLToPath } from 'node:url';
import type { Catalog, ModelEntry, RequestDescriptor, RoutingPolicy } from '../src/index.js';
import { loadCatalog, loadPolicy } from '../src/index.js';

export const examplePath = (name: string): string => fileURLToPath(new URL(`../examples/${name}`, import.meta.url));

export const exampleCatalog = (): Catalog => loadCatalog(examplePath('catalog.json'));
export const baselinePolicy = (catalog = exampleCatalog()): RoutingPolicy => loadPolicy(examplePath('policy.baseline.json'), catalog);
export const candidatePolicy = (catalog = exampleCatalog()): RoutingPolicy => loadPolicy(examplePath('policy.candidate.json'), catalog);

export function makeModel(provider: string, model: string, overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    provider,
    model,
    capabilities: { tools: true, vision: false, jsonOutput: true, maxContextTokens: 100_000 },
    pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
    latencyClass: 'standard',
    regions: ['us', 'eu'],
    qualityTier: 3,
    ...overrides,
  };
}

export function makeCatalog(...models: ModelEntry[]): Catalog {
  return { schemaVersion: 1, models };
}

export function makePolicy(overrides: Partial<RoutingPolicy> = {}): RoutingPolicy {
  return {
    schemaVersion: 1,
    name: 'test-policy',
    weights: { cost: 1, quality: 1, latency: 1 },
    fallbackDepth: 2,
    distinctProviderFallbacks: false,
    deny: [],
    taskOverrides: {},
    ...overrides,
  };
}

export function makeRequest(overrides: Partial<RequestDescriptor> = {}): RequestDescriptor {
  return {
    id: 'r-1',
    tenantId: 'tenant-a',
    taskClass: 'general',
    requiredCapabilities: [],
    estimatedInputTokens: 1000,
    estimatedOutputTokens: 200,
    ...overrides,
  };
}
