// Fixture for security.yaml. Run with: semgrep --test --config .
//
// Note: the API-key branches of governance-no-hardcoded-secrets (Stripe, GitHub,
// AWS, private-key headers) are deliberately NOT fixture-tested — a file
// containing strings that match those patterns trips secret scanners and push
// protection on every push. The connection-string branch below exercises the same
// rule, and the key patterns are covered by review of the regex itself.

declare const db: { query(sql: string, params?: unknown[]): Promise<any> };
declare function Body(): ParameterDecorator;
declare function Post(): MethodDecorator;

// ruleid: governance-no-hardcoded-secrets
const DB_URL = 'postgres://app:not-a-real-password@db.internal:5432/prod';

// ok: governance-no-hardcoded-secrets
const DB_URL_FROM_CONFIG = process.env.DATABASE_URL;

export class QueryExamples {
  async bad(email: string): Promise<unknown> {
    // ruleid: governance-no-raw-sql-interpolation
    return db.query(`SELECT * FROM users WHERE email = '${email}'`);
  }

  async good(email: string): Promise<unknown> {
    // ok: governance-no-raw-sql-interpolation
    return db.query('SELECT * FROM users WHERE email = $1', [email]);
  }
}

export class BodyExamples {
  // ruleid: governance-dto-validation-any-body
  @Post()
  createUntyped(@Body() body: any) {
    return body;
  }

  // ruleid: governance-dto-validation-any-body
  @Post()
  createUnannotated(@Body() body) {
    return body;
  }

  // ok: governance-dto-validation-any-body
  @Post()
  createTyped(@Body() dto: CreateUserDto) {
    return dto;
  }
}

declare class CreateUserDto {
  email: string;
}
