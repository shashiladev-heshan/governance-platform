// Fixture for error-handling.yaml. Run with: semgrep --test --config .

declare const audit: { record(e: unknown): Promise<void> };
declare const payments: { charge(o: unknown): Promise<void> };
declare const logger: { error(...a: unknown[]): void; warn(...a: unknown[]): void };
declare const cache: { get(k: string): Promise<unknown> };
declare const source: { get(k: string): Promise<unknown> };

export async function emptyCatch(event: unknown): Promise<void> {
  // ruleid: governance-no-empty-catch
  try {
    await audit.record(event);
  } catch (err) {}
}

export async function logOnly(order: unknown): Promise<void> {
  // ruleid: governance-log-only-catch
  try {
    await payments.charge(order);
  } catch (err) {
    logger.error('charge failed', err);
  }
}

export async function consoleOnly(order: unknown): Promise<void> {
  // ruleid: governance-log-only-catch
  try {
    await payments.charge(order);
  } catch (err) {
    console.error('charge failed', err);
  }
}

export function throwsString(): void {
  // ruleid: governance-throw-non-error
  throw 'invalid state';
}

export async function translatesAndRethrows(order: unknown): Promise<void> {
  // ok: governance-no-empty-catch
  // ok: governance-log-only-catch
  try {
    await payments.charge(order);
  } catch (err) {
    throw new PaymentDeclinedError('declined', { cause: err });
  }
}

export async function deliberateFallback(key: string): Promise<unknown> {
  // The logger call is followed by a real fallback, so the caller still gets a
  // correct answer. Semgrep cannot tell these apart — this is precisely the
  // judgement the validator agent exists to make.
  // ruleid: governance-log-only-catch
  try {
    return await cache.get(key);
  } catch (err) {
    logger.warn('cache read failed, falling back to source', err);
  }
  return source.get(key);
}

declare class PaymentDeclinedError extends Error {
  constructor(message: string, options?: { cause?: unknown });
}
