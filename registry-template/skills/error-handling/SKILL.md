---
name: error-handling
description: How failures are represented, propagated and surfaced — typed domain errors, no swallowed exceptions, no internal detail in client responses. Use when writing or reviewing any try/catch, error class, exception filter or error response.
metadata:
  rules: [no-swallowed-errors, typed-domain-errors, no-error-detail-leak]
---

# Error Handling

The governing idea: **a failure must stay visible until something deliberately
decides what to do about it.** Most of the incidents we have had trace back to an
error that was caught, logged, and then ignored.

## no-swallowed-errors — catching is a decision, not a formality

A `catch` block must do one of three things:

1. **Handle** it — take a deliberate, documented fallback path
2. **Translate** it — wrap in a domain error and rethrow
3. **Fail** the operation — rethrow as-is

Logging and continuing is swallowing, unless the fallback is the point.

**Bad** — empty catch:

```ts
try {
  await this.audit.record(event);
} catch {}
```

**Bad** — log-and-continue, so the caller believes it succeeded:

```ts
try {
  await this.payments.charge(order);
} catch (err) {
  this.logger.error('charge failed', err);
}
return { status: 'confirmed' };   // it was not confirmed
```

**Good** — translate and rethrow:

```ts
try {
  await this.payments.charge(order);
} catch (err) {
  throw new PaymentDeclinedError(order.id, { cause: err });
}
```

**Good** — a deliberate, documented fallback (this is a handled error, not a
swallowed one, because the degraded path is the intended behaviour):

```ts
try {
  return await this.cache.get(key);
} catch (err) {
  // Cache is best-effort: a cache outage must not fail the request.
  this.logger.warn({ err, key }, 'cache read failed, falling back to source');
  return this.source.get(key);
}
```

**Reviewer test:** after the catch block, can the caller still tell whether the
operation succeeded? If not, the error was swallowed.

## typed-domain-errors — throw meaning, not strings

Domain failures get a class. That class is what an exception filter maps to an
HTTP status, so controllers never need to translate errors themselves.

**Bad:**

```ts
throw new Error('user not found');
throw 'invalid state';
throw new HttpException('nope', 400);   // HTTP concern leaking into a service
```

**Good:**

```ts
export class UserNotFoundError extends DomainError {
  constructor(readonly userId: string) {
    super(`user ${userId} not found`);
  }
}

// one filter, one place, for the whole app
@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter { ... }
```

Services throw domain errors. Only the filter knows about status codes.

## no-error-detail-leak — the client gets a message, not your internals

Responses carry a stable error code and a safe message. Stack traces, driver
errors, SQL fragments, file paths and upstream response bodies stay in the logs,
correlated by a request id.

**Bad:**

```ts
catch (err) {
  throw new InternalServerErrorException(err.message);   // may contain the SQL
}

return res.status(500).json({ error: err.stack });
```

**Good:**

```ts
catch (err) {
  this.logger.error({ err, requestId }, 'order lookup failed');
  throw new ServiceUnavailableError('ORDER_LOOKUP_FAILED', { requestId });
}
```

Client sees:

```json
{ "code": "ORDER_LOOKUP_FAILED", "message": "Could not load the order", "requestId": "01HZ..." }
```

**Reviewer test:** could the response body tell an attacker which database, which
table, or which internal host is in use? Then it leaks.
