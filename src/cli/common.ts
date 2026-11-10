import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ConfigError } from '../validate.js';

export interface IO {
  out(text: string): void;
  err(text: string): void;
}

export const processIO: IO = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** Repository root, resolved from this file so both `tsx src/...` and `node dist/...` work from any cwd. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Resolve a user-supplied or bundled path. Bundled defaults are relative to the package root. */
export function bundled(relativePath: string): string {
  return resolve(ROOT, relativePath);
}

/** True when the given module is the process entry point (symlink-safe, so it also works for npm bins). */
export function isEntryPoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/** Run a CLI body, mapping known failures to exit code 2 with a readable message. */
export function guarded(io: IO, body: () => number): number {
  try {
    return body();
  } catch (error) {
    if (error instanceof ConfigError || error instanceof UsageError) {
      io.err(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export function parseNumberFlag(name: string, value: string | undefined, min?: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n)) throw new UsageError(`--${name} expects a number, got ${JSON.stringify(value)}`);
  if (min !== undefined && n < min) throw new UsageError(`--${name} must be >= ${min}, got ${value}`);
  return n;
}
