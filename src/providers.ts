/**
 * Provider adapter interface and mock implementations.
 *
 * The gateway talks only to `ProviderAdapter`. A real SDK-backed adapter would
 * implement the same two members; nothing in this repository performs network I/O.
 */

export interface ProviderCall {
  requestId: string;
  tenantId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** An adapter failure. `retryable` tells the gateway whether another route may be tried. */
export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ProviderAdapter {
  readonly provider: string;
  invoke(call: ProviderCall, signal: AbortSignal): Promise<ProviderResult>;
}

export type MockBehavior =
  | { kind: 'ok' }
  | { kind: 'error'; code: string; retryable: boolean }
  | { kind: 'hang' };

/** Decides how a mock call behaves. `callIndex` counts calls to this adapter from 0. */
export type MockScript = (call: ProviderCall, callIndex: number) => MockBehavior;

/** A scripted in-memory adapter. Records every call it receives. */
export class MockProvider implements ProviderAdapter {
  readonly calls: ProviderCall[] = [];

  constructor(
    readonly provider: string,
    private readonly script: MockScript = () => ({ kind: 'ok' }),
  ) {}

  invoke(call: ProviderCall, signal: AbortSignal): Promise<ProviderResult> {
    const behavior = this.script(call, this.calls.length);
    this.calls.push(call);
    switch (behavior.kind) {
      case 'ok':
        return Promise.resolve({
          text: `mock response from ${this.provider}/${call.model} for ${call.requestId}`,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
        });
      case 'error':
        return Promise.reject(new ProviderError(behavior.code, `${this.provider} mock failure: ${behavior.code}`, behavior.retryable));
      case 'hang':
        return new Promise<ProviderResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new ProviderError('ABORTED', 'call aborted by caller', true));
          });
        });
    }
  }
}
