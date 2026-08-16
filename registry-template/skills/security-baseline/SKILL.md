---
name: security-baseline
description: Non-negotiable security rules — no secrets in source, no SQL string interpolation, explicit authorisation on every mutating route. Use when writing or reviewing queries, route guards, or anything touching credentials.
metadata:
  rules: [no-hardcoded-secrets, no-raw-sql-interpolation, authz-on-mutations]
---

# Security Baseline

The rules in this skill block in **every** tier, including startup work. They are
here because each one has been a real finding in a client review.

## no-hardcoded-secrets — a committed secret is an incident

No API keys, tokens, passwords, connection strings or private keys in source,
including test fixtures and commented-out code. Git history is forever; rotation
is the only remedy.

**Bad:**

```ts
const stripe = new Stripe('sk_live_51Hx...');
const DB_URL = 'postgres://app:hunter2@db.internal:5432/prod';
// const OLD_TOKEN = 'ghp_...';   // still a secret, still committed
```

**Good:**

```ts
constructor(private readonly config: ConfigService) {}
const stripe = new Stripe(this.config.getOrThrow('stripe.secretKey'));
```

Test fixtures use obviously-fake values (`sk_test_dummy`) and never a real
credential from any environment.

## no-raw-sql-interpolation — parameterise, always

Never build SQL by concatenating or interpolating values. The parameterised form
is never harder to write.

**Bad:**

```ts
await this.db.query(`SELECT * FROM users WHERE email = '${email}'`);
await this.repo.query('DELETE FROM sessions WHERE user_id = ' + userId);
this.repo.createQueryBuilder('u').where(`u.name LIKE '%${term}%'`);
```

**Good:**

```ts
await this.db.query('SELECT * FROM users WHERE email = $1', [email]);
this.repo.createQueryBuilder('u').where('u.name LIKE :term', { term: `%${term}%` });
```

Identifiers that genuinely cannot be parameterised (a sort column) must be
validated against an allow-list, never interpolated from input.

## authz-on-mutations — authentication is not authorisation

Every route that creates, updates or deletes carries an explicit authorisation
decision about *this* actor and *this* resource. "The user is logged in" is not
an authorisation check.

**Bad** — any authenticated user can delete any project:

```ts
@UseGuards(AuthGuard)
@Delete(':id')
remove(@Param('id') id: string) {
  return this.projects.delete(id);
}
```

**Good** — the guard checks the actor's relationship to the resource:

```ts
@UseGuards(AuthGuard, ProjectRoleGuard)
@RequireProjectRole('owner')
@Delete(':id')
remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
  return this.projects.delete(id, user);
}
```

Equally acceptable: the service performs the check and throws a domain
`ForbiddenError`. What is not acceptable is no check at all, or a check that only
proves identity.

**Reviewer test:** for a mutating route, can user A affect user B's data by
changing only the id in the URL? If the answer is not clearly no, this rule fires.
