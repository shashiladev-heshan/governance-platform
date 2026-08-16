// Fixture for config-module-only.yaml. Run with: semgrep --test --config .
// A rule that silently stops matching is worse than one that fails to parse, so
// every rule has at least one positive and one negative case here.

export class BadService {
  // ruleid: governance-config-module-only
  private readonly timeout = Number(process.env.HTTP_TIMEOUT ?? 5000);

  // ruleid: governance-config-module-only
  private readonly key = process.env['STRIPE_KEY'];
}

export class GoodService {
  constructor(private readonly config: ConfigService) {}

  // ok: governance-config-module-only
  private readonly timeout = this.config.get('app.httpTimeoutMs');
}

declare class ConfigService {
  get(key: string): unknown;
}
