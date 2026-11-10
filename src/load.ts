import { readFileSync } from 'node:fs';
import type { Catalog, RequestDescriptor, RoutingPolicy } from './types.js';
import { ConfigError, validateCatalog, validatePolicy, validateRequest } from './validate.js';

function readJson(path: string, subject: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${subject} file ${path}`, [`cannot be read: ${message}`]);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${subject} file ${path}`, [`not valid JSON: ${message}`]);
  }
}

function rethrow(subject: string, path: string, error: unknown): never {
  if (error instanceof ConfigError) throw new ConfigError(`${subject} file ${path}`, error.issues);
  throw error;
}

export function loadCatalog(path: string): Catalog {
  const raw = readJson(path, 'Catalog');
  try {
    return validateCatalog(raw);
  } catch (error) {
    return rethrow('Catalog', path, error);
  }
}

export function loadPolicy(path: string, catalog?: Catalog): RoutingPolicy {
  const raw = readJson(path, 'Policy');
  try {
    return validatePolicy(raw, catalog);
  } catch (error) {
    return rethrow('Policy', path, error);
  }
}

export function loadRequest(path: string): RequestDescriptor {
  const raw = readJson(path, 'Request');
  try {
    return validateRequest(raw);
  } catch (error) {
    return rethrow('Request', path, error);
  }
}
