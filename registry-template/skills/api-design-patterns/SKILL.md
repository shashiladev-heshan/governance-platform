---
name: api-design-patterns
description: Public HTTP API conventions — route versioning, the standard cursor pagination envelope, and response shape consistency. Use when adding or reviewing any externally-visible route.
metadata:
  rules: [api-versioned-routes, api-consistent-pagination]
---

# API Design Patterns

These rules are about what a client integration costs us six months from now.
Both are advisory in every tier — they are judgement calls, and blocking a
hotfix over a route prefix is worse than the inconsistency.

## api-versioned-routes — version from the first commit

Every externally-reachable route lives under a version segment. Adding one later
is a breaking change for whoever already integrated.

**Bad:**

```ts
@Controller('orders')
```

**Good:**

```ts
@Controller({ path: 'orders', version: '1' })   // → /v1/orders
```

Internal-only routes (health, readiness, metrics) are exempt and stay unversioned.

## api-consistent-pagination — one envelope, everywhere

Collection endpoints use cursor pagination with the same envelope across every
service, so a client writes the pagination loop once.

**Bad** — three services, three shapes:

```ts
return { items, page: 2, totalPages: 7 };
return { data, offset: 40, limit: 20 };
return orders;                              // unbounded
```

**Good:**

```ts
export class PageDto<T> {
  data!: T[];
  pageInfo!: {
    nextCursor: string | null;
    hasNextPage: boolean;
  };
}

@Get()
list(@Query() query: ListOrdersDto): Promise<PageDto<OrderResponseDto>> {
  return this.orders.list(query.cursor, query.limit ?? 50);
}
```

Rules of the envelope:

- `limit` is always capped server-side (default 50, max 200) — an unbounded
  collection endpoint is a denial-of-service waiting for the first large tenant
- `nextCursor` is opaque to the client; never expose a raw database offset or id
- an empty page returns `data: []` with `hasNextPage: false`, never `404`

**Reviewer test:** does the endpoint return an array whose length is decided by
the data rather than by the caller? Then it needs pagination.
