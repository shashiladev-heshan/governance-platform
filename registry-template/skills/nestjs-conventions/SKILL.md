---
name: nestjs-conventions
description: Structural conventions for NestJS services — controller/service/repository layering, DTO validation, and typed configuration. Use when writing or reviewing any Nest module, controller, service or provider.
metadata:
  rules: [thin-controllers, dto-validation, config-module-only, layered-imports]
---

# NestJS Conventions

These are the structural rules a Nest service in this org is expected to follow.
They exist because they are the four things that, when broken, make a service
expensive to hand over to a client team.

## thin-controllers — controllers delegate, they do not decide

A controller's job is transport: bind the route, validate input, call one service
method, shape the response. Anything that would still be true if the request
arrived over a queue instead of HTTP belongs in a service.

**Bad** — the ordering rules live in the controller, so a scheduled job can never reuse them:

```ts
@Post()
async create(@Body() body: CreateOrderDto) {
  const customer = await this.customers.findOne(body.customerId);
  if (!customer) throw new NotFoundException();
  if (customer.creditHold) throw new ForbiddenException();
  const total = body.lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
  if (total > customer.creditLimit) throw new ForbiddenException();
  return this.orders.save({ ...body, total });
}
```

**Good** — one call; the policy lives where it can be unit-tested and reused:

```ts
@Post()
async create(@Body() dto: CreateOrderDto): Promise<OrderResponseDto> {
  return this.orderService.placeOrder(dto);
}
```

**Reviewer test:** if the controller method contains a branch that is not about
HTTP (status codes, headers, content negotiation), it is business logic.

## dto-validation — every request body is a validated DTO

Bodies, queries and params are untrusted input. They enter the application
through a `class-validator` DTO and a global `ValidationPipe` with
`whitelist: true` and `forbidNonWhitelisted: true`.

**Bad:**

```ts
@Post()
create(@Body() body: any) { ... }

@Post()
create(@Body() body: { email: string }) { ... }   // compile-time only, no runtime check
```

**Good:**

```ts
export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(2, 64)
  displayName!: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;
}

@Post()
create(@Body() dto: CreateUserDto) { ... }
```

A TypeScript interface or inline type on `@Body()` is **not** validation — it
disappears at runtime. This is the most common false-pass in review.

## config-module-only — environment access is centralised and typed

`process.env` is read in exactly one place: the config module, which validates
the whole environment at boot and exposes a typed accessor. A missing variable
must crash on startup, not at 3am on the first request that touches that branch.

**Bad:**

```ts
const timeout = Number(process.env.HTTP_TIMEOUT ?? 5000);
const key = process.env.STRIPE_KEY!;
```

**Good:**

```ts
// config/app.config.ts — validated once, at boot
export const appConfig = registerAs('app', () => ({
  httpTimeoutMs: envSchema.parse(process.env).HTTP_TIMEOUT,
}));

// anywhere else
constructor(private readonly config: ConfigService) {}
const timeout = this.config.get('app.httpTimeoutMs', { infer: true });
```

The only files permitted to reference `process.env` are under `src/config/**`
and test setup files.

## layered-imports — controller → service → repository, one direction

Controllers import services. Services import repositories. Nothing imports
backwards, and controllers never touch an ORM entity or repository directly.

**Bad:**

```ts
@Controller('users')
export class UserController {
  constructor(
    @InjectRepository(UserEntity) private readonly repo: Repository<UserEntity>,
  ) {}

  @Get(':id')
  get(@Param('id') id: string) {
    return this.repo.findOneBy({ id });   // transport is now coupled to the schema
  }
}
```

**Good:**

```ts
@Controller('users')
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get(':id')
  get(@Param('id') id: string): Promise<UserResponseDto> {
    return this.users.getById(id);
  }
}
```

This rule is `overridable` per project: a genuinely CRUD-only internal admin
service may weaken it in `governance.json`, and that override is recorded and
visible in CI output.
