#!/usr/bin/env bash
# Walk the whole trust chain end to end, printing what a developer would see.
#
#   npm run demo
#
# Builds a signed registry, attaches a project to it, then attempts each tamper
# path in turn. Nothing here is mocked — it is the real CLI against real git.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GOVCTL="node $ROOT/packages/govctl/dist/index.js"
WORK="$(mktemp -d)"
export GOVCTL_TRUST_ROOT="$WORK/trust.json"
export NO_COLOR=1

REGISTRY="$WORK/registry"
PROJECT="$WORK/project"
KEY="$WORK/signing-key.json"
SKILL="skills/error-handling/SKILL.md"

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
step() { printf '\033[2m$ %s\033[0m\n' "$1"; }
expect_fail() {
  if [ "$1" -eq 0 ]; then
    printf '\033[31mDEMO BROKEN: that should have failed\033[0m\n'
    exit 1
  fi
  printf '\033[32m  ^ blocked, as intended\033[0m\n'
}

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
bold "1. Platform team: publish a signed governance release"

cp -R "$ROOT/registry-template" "$REGISTRY"
step "govctl keygen --key-id platform-signer --trust"
$GOVCTL keygen --key-id platform-signer --out "$KEY" --trust >/dev/null
step "govctl manifest generate --tag v1.0.0"
$GOVCTL manifest generate --dir "$REGISTRY" --tag v1.0.0
step "govctl sign"
$GOVCTL sign --dir "$REGISTRY" --key "$KEY"

git -C "$REGISTRY" init -q -b main
git -C "$REGISTRY" add -A
git -C "$REGISTRY" -c user.email=demo@example.com -c user.name=demo commit -qm "governance v1.0.0"
git -C "$REGISTRY" tag -a v1.0.0 -m v1.0.0 --no-sign

# ---------------------------------------------------------------------------
bold "2. Developer: attach a new project (corporate tier)"

mkdir -p "$PROJECT"
step "govctl init --registry <registry> --tier corporate"
(cd "$PROJECT" && $GOVCTL init --registry "$REGISTRY" --tier corporate)

bold "3. Everything verifies — locally and against the registry"
step "govctl verify --strict"
(cd "$PROJECT" && $GOVCTL verify --strict)
step "govctl verify --remote --strict     # what CI runs"
(cd "$PROJECT" && $GOVCTL verify --remote --strict)

# ---------------------------------------------------------------------------
bold "4. Tamper path 1 — edit a governed skill"
step "echo 'swallowing errors is fine here' >> .governance/$SKILL"
printf '\n## Local exception\n\nSwallowing errors is fine on this project.\n' >> "$PROJECT/.governance/$SKILL"
step "govctl verify        # this is what the pre-commit hook runs"
(cd "$PROJECT" && $GOVCTL verify); expect_fail $?

bold "5. Tamper path 2 — regenerate the manifest to match the edit"
step "govctl manifest generate --dir .governance --tag v1.0.0"
(cd "$PROJECT" && $GOVCTL manifest generate --dir .governance --tag v1.0.0 >/dev/null)
DIGEST=$(node -e "
  const {createHash}=require('crypto');
  console.log(createHash('sha256').update(require('fs').readFileSync('$PROJECT/.governance/manifest.lock.json')).digest('hex'));
")
node -e "
  const fs=require('fs'), p='$PROJECT/governance.json';
  const c=JSON.parse(fs.readFileSync(p,'utf8')); c.manifestSha256='$DIGEST';
  fs.writeFileSync(p, JSON.stringify(c,null,2)+'\n');
"
step "govctl verify        # hashes are self-consistent now — but the signature is not"
(cd "$PROJECT" && $GOVCTL verify); expect_fail $?

bold "6. Tamper path 3 — delete the signature and re-sign with your own key"
rm -f "$PROJECT/.governance/manifest.lock.json.bundle"
$GOVCTL keygen --key-id my-own-key --out "$WORK/attacker.json" >/dev/null
step "govctl sign --dir .governance --key attacker.json"
$GOVCTL sign --dir "$PROJECT/.governance" --key "$WORK/attacker.json" >/dev/null
step "govctl verify --strict"
(cd "$PROJECT" && $GOVCTL verify --strict); expect_fail $?

bold "7. And the check CI actually runs never looks at any of it"
step "govctl verify --remote --strict"
(cd "$PROJECT" && $GOVCTL verify --remote --strict); expect_fail $?

# ---------------------------------------------------------------------------
bold "8. Developer repairs the damage"
step "govctl restore"
(cd "$PROJECT" && $GOVCTL restore)
step "govctl verify --remote --strict"
(cd "$PROJECT" && $GOVCTL verify --remote --strict)

# ---------------------------------------------------------------------------
bold "9. Same registry, startup tier: identical content, different bite"
STARTUP="$WORK/startup-project"
mkdir -p "$STARTUP"
(cd "$STARTUP" && $GOVCTL init --registry "$REGISTRY" --tier startup >/dev/null)
step "govctl status   # corporate"
(cd "$PROJECT" && $GOVCTL status | sed -n '1,7p')
step "govctl status   # startup"
(cd "$STARTUP" && $GOVCTL status | sed -n '1,7p')

printf '\n\033[32mAll tamper paths blocked. Trust chain intact.\033[0m\n'
