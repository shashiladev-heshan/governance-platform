#!/usr/bin/env bash
# Full local rehearsal: a real registry repo, a real project repo, real git hooks.
#
#   bash scripts/pilot-local.sh [workdir]      # default: ./pilot
#
# Nothing is mocked except the LLM call (unless ANTHROPIC_API_KEY is set). Both
# repos are left on disk afterwards so you can keep poking at them — push the
# registry to GitHub and you are on the real path.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${1:-$ROOT/pilot}"
GOVCTL="node $ROOT/packages/govctl/dist/index.js"
VALIDATOR="node $ROOT/packages/validator-agent/dist/index.js"

REGISTRY="$WORK/registry"
PROJECT="$WORK/demo-service"
KEYS="$WORK/keys"
export GOVCTL_TRUST_ROOT="$WORK/trust.json"

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
step() { printf '\033[2m$ %s\033[0m\n' "$1"; }
note() { printf '\033[2m  %s\033[0m\n' "$1"; }

# The pilot dir is a throwaway rehearsal (gitignored), so a re-run just starts
# over. Anything you want to keep, copy out first or pass a different path.
if [ -e "$WORK" ]; then
  echo "› clearing the previous rehearsal at $WORK"
  rm -rf "$WORK"
fi

git_c() { git -c user.email=pilot@example.com -c user.name=pilot -c commit.gpgsign=false "$@"; }

bold "0. Build the tooling"
(cd "$ROOT" && npm install --silent && npm run build --silent)
mkdir -p "$WORK" "$KEYS"

# ---------------------------------------------------------------------------
bold "1. Stand up the governance registry (this becomes your governance repo)"
cp -R "$ROOT/registry-template" "$REGISTRY"
step "govctl keygen --key-id platform-signer --trust"
$GOVCTL keygen --key-id platform-signer --out "$KEYS/signing-key.json" --trust
step "govctl manifest generate --tag v1.0.0 && govctl sign"
$GOVCTL manifest generate --dir "$REGISTRY" --tag v1.0.0
$GOVCTL sign --dir "$REGISTRY" --key "$KEYS/signing-key.json"

git -C "$REGISTRY" init -q -b main
git_c -C "$REGISTRY" add -A
git_c -C "$REGISTRY" commit -qm "governance v1.0.0"
git -C "$REGISTRY" tag -a v1.0.0 -m v1.0.0 --no-sign
note "registry: $REGISTRY (tagged v1.0.0, manifest signed)"

# ---------------------------------------------------------------------------
bold "2. Create a new project repo, the way a developer would"
mkdir -p "$PROJECT/src/orders"

cat > "$PROJECT/package.json" <<'JSON'
{
  "name": "demo-service",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "scripts": { "prepare": "lefthook install" },
  "devDependencies": { "lefthook": "^2.1.10" }
}
JSON

cat > "$PROJECT/tsconfig.json" <<'JSON'
{ "compilerOptions": { "target": "ES2022", "module": "CommonJS", "strict": true } }
JSON

cat > "$PROJECT/src/orders/orders.controller.ts" <<'TS'
import { Controller, Get, Param } from '@nestjs/common';
import { OrderService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrderService) {}

  @Get(':id')
  get(@Param('id') id: string) {
    return this.orders.getById(id);
  }
}
TS

cat > "$PROJECT/src/orders/orders.service.ts" <<'TS'
export class OrderService {
  async getById(id: string) {
    return { id };
  }
}
TS

printf 'node_modules/\ndist/\n' > "$PROJECT/.gitignore"

git -C "$PROJECT" init -q -b main
git_c -C "$PROJECT" add -A
git_c -C "$PROJECT" commit -qm "initial service"
note "project: $PROJECT"

# ---------------------------------------------------------------------------
bold "3. Attach it to governance"
step "govctl init --registry $REGISTRY --tier corporate"
(cd "$PROJECT" && $GOVCTL init --registry "$REGISTRY" --tier corporate)

mkdir -p "$PROJECT/.github/workflows"
cp "$ROOT/project-integration/.github/workflows/governance-verify.pilot.yml" "$PROJECT/.github/workflows/"
cp "$ROOT/project-integration/CODEOWNERS" "$PROJECT/.github/CODEOWNERS"
note "copied the pilot workflow and CODEOWNERS into .github/"

step "npm install   # brings in lefthook"
(cd "$PROJECT" && npm install --silent --no-audit --no-fund)
step "npx lefthook install"
(cd "$PROJECT" && npx lefthook install >/dev/null)
note "git hooks installed: $(ls "$PROJECT/.git/hooks" | grep -c 'pre-commit\|pre-push') of 2 present"

git_c -C "$PROJECT" add -A
git_c -C "$PROJECT" commit -qm "chore: attach governance (corporate tier)" >/dev/null
note "committed governance.json, .governance/, lefthook.yml, .github/"

# ---------------------------------------------------------------------------
bold "4. The pre-commit hook, for real"
step "echo '## Exception' >> .governance/skills/error-handling/SKILL.md"
printf '\n## Local exception\n\nSwallowing errors is fine here.\n' \
  >> "$PROJECT/.governance/skills/error-handling/SKILL.md"

step "git commit -am 'relax the rules'   # this must fail"
set +e
(cd "$PROJECT" && git_c commit -qam "relax the rules" 2>&1 | tail -20)
COMMIT_RC=${PIPESTATUS[0]}
set -e
if [ "$COMMIT_RC" -eq 0 ]; then
  echo "PILOT BROKEN: the commit should have been rejected"
  exit 1
fi
printf '\033[32m  ^ commit rejected by the pre-commit hook\033[0m\n'

step "govctl restore"
(cd "$PROJECT" && $GOVCTL restore | tail -6)

# ---------------------------------------------------------------------------
bold "5. Write code that violates the rules, on a branch"
git -C "$PROJECT" checkout -q -b feat/checkout

cat > "$PROJECT/src/orders/checkout.controller.ts" <<'TS'
import { Body, Controller, Post } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Controller('checkout')
export class CheckoutController {
  constructor(private readonly db: DataSource) {}

  @Post()
  async checkout(@Body() body: any) {
    const timeout = Number(process.env.CHECKOUT_TIMEOUT ?? 5000);

    const customer = await this.db.query(
      `SELECT * FROM customers WHERE email = '${body.email}'`,
    );

    if (customer.creditHold) {
      return { status: 'rejected' };
    }

    const total = body.lines.reduce((sum: number, l: any) => sum + l.qty * l.unitPrice, 0);

    try {
      await this.db.query('INSERT INTO orders (total) VALUES ($1)', [total]);
    } catch (err) {
      console.error('insert failed', err);
    }

    return { status: 'confirmed', total, timeout };
  }
}
TS

git_c -C "$PROJECT" add -A
git_c -C "$PROJECT" commit -qm "feat: checkout endpoint" --no-verify
note "committed with --no-verify (the local layer is bypassable, by design)"

bold "6. What CI would run — integrity first"
step "govctl verify --remote --strict"
(cd "$PROJECT" && $GOVCTL verify --remote --strict)

bold "7. Deterministic pattern rules"
if command -v semgrep >/dev/null 2>&1; then
  step "semgrep scan --config .governance/policies/semgrep/"
  (cd "$PROJECT" && semgrep scan --config .governance/policies/semgrep/ --error --metrics=off) || true
else
  note "semgrep not installed — skipping. Install with: pipx install semgrep"
  note "it would flag: config-module-only, no-raw-sql-interpolation, dto-validation, no-swallowed-errors"
fi

bold "8. Semantic review of the real diff"
(cd "$PROJECT" && git diff main...HEAD --unified=3 > pr.diff)
note "$(wc -l < "$PROJECT/pr.diff" | tr -d ' ') lines of diff"

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  step "governance-validator review --diff pr.diff   # real agent"
  (cd "$PROJECT" && GOVERNANCE_TRACE_STDOUT=1 $VALIDATOR review \
      --diff pr.diff --governance .governance --config governance.json \
      --json-out verdict.json --markdown-out verdict.md) || true
else
  note "ANTHROPIC_API_KEY not set — running the validator in mock mode"
  note "the pipeline is real; only the model call is stubbed"
  step "GOVERNANCE_AGENT_MODE=mock governance-validator review --diff pr.diff"
  (cd "$PROJECT" && GOVERNANCE_AGENT_MODE=mock \
    GOVERNANCE_MOCK_VERDICT='{"findings":[
      {"ruleId":"dto-validation","severity":"error","file":"src/orders/checkout.controller.ts","line":10,
       "rationale":"@Body() is typed any, so nothing validates the payload at runtime. Bind a class-validator DTO so malformed input is rejected at the boundary.",
       "suggestedFix":"  async checkout(@Body() dto: CheckoutDto) {"},
      {"ruleId":"thin-controllers","severity":"error","file":"src/orders/checkout.controller.ts","line":17,
       "rationale":"Credit-hold and order-total rules live in the controller, so a queue consumer or job cannot reuse them. Move them into a service."},
      {"ruleId":"no-swallowed-errors","severity":"error","file":"src/orders/checkout.controller.ts","line":26,
       "rationale":"The insert failure is logged and then ignored, so the caller is told the order was confirmed when it was not."}
    ]}' \
    $VALIDATOR review --diff pr.diff --governance .governance --config governance.json \
      --json-out verdict.json --markdown-out verdict.md)
fi

step "governance-validator gate --verdict verdict.json   # this is the check result"
set +e
(cd "$PROJECT" && $VALIDATOR gate --verdict verdict.json)
GATE_RC=$?
set -e
note "gate exit code: $GATE_RC (non-zero = governance-semantic fails, PR blocked)"

echo
printf '\033[1mThe PR comment that would be posted:\033[0m\n\n'
sed 's/^/  /' "$PROJECT/verdict.md"

# ---------------------------------------------------------------------------
bold "9. Same code, startup tier"
node -e "
  const fs=require('fs'), p='$PROJECT/governance.json';
  const c=JSON.parse(fs.readFileSync(p,'utf8')); c.tier='startup';
  fs.writeFileSync(p, JSON.stringify(c,null,2)+'\n');
"
(cd "$PROJECT" && GOVERNANCE_AGENT_MODE=mock \
  GOVERNANCE_MOCK_VERDICT="$(node -e "
    const v=JSON.parse(require('fs').readFileSync('$PROJECT/verdict.json','utf8'));
    console.log(JSON.stringify({findings:[...v.blocking,...v.warnings]}));
  ")" \
  $VALIDATOR review --diff pr.diff --governance .governance --config governance.json \
    --json-out verdict-startup.json >/dev/null)
set +e
(cd "$PROJECT" && $VALIDATOR gate --verdict verdict-startup.json)
STARTUP_RC=$?
set -e
note "startup tier gate exit code: $STARTUP_RC (same findings, advisory)"
node -e "
  const fs=require('fs'), p='$PROJECT/governance.json';
  const c=JSON.parse(fs.readFileSync(p,'utf8')); c.tier='corporate';
  fs.writeFileSync(p, JSON.stringify(c,null,2)+'\n');
"

echo
printf '\033[32mRehearsal complete.\033[0m\n'
cat <<EOF

  registry   $REGISTRY
  project    $PROJECT
  trust root $GOVCTL_TRUST_ROOT

Next, to take it to GitHub — see docs/PILOT.md:
  1. push $REGISTRY to your-org/governance, push the v1.0.0 tag
  2. push $PROJECT to a repo
  3. set repo variables GOVERNANCE_REPO, GOVERNANCE_TRUST_ROOT and secret GOVERNANCE_REPO_TOKEN
  4. open a PR from feat/checkout and watch the three checks
EOF
