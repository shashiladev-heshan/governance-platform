#!/usr/bin/env bash
# Publish the governance packages, in dependency order.
#
#   bash scripts/publish.sh                       # dry run (default)
#   bash scripts/publish.sh --yes                 # actually publish
#   bash scripts/publish.sh --yes --registry http://localhost:4873
#
# Order matters: policy-core first, because govctl and the validator depend on it
# and npm resolves that dependency from the registry, not from the workspace.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DRY_RUN=1
REGISTRY=""
PACKAGES=(@shashiladev-heshan/policy-core @shashiladev-heshan/govctl @shashiladev-heshan/governance-validator)

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) DRY_RUN=0; shift ;;
    --registry) REGISTRY="$2"; shift 2 ;;
    *) echo "unknown argument: $1"; exit 2 ;;
  esac
done

REG_ARGS=()
[ -n "$REGISTRY" ] && REG_ARGS=(--registry "$REGISTRY")

echo "› building and testing before publish"
npm install --silent
npm run build --silent
npm test --silent > /dev/null || { echo "tests failed — refusing to publish"; exit 1; }

# A package published without its build output is worse than no package: every
# consumer's CI breaks at once, and the fix is a version bump.
for pkg in "${PACKAGES[@]}"; do
  dir=$(npm query ".workspace" --json 2>/dev/null | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const w=JSON.parse(s).find(x=>x.name==='$pkg');
      process.stdout.write(w? w.location : '');
    });")
  if [ -z "$dir" ] || [ ! -d "$dir/dist" ]; then
    echo "✘ $pkg has no dist/ — build failed?"
    exit 1
  fi
done

for pkg in "${PACKAGES[@]}"; do
  echo
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "› DRY RUN: $pkg"
    npm publish -w "$pkg" --dry-run "${REG_ARGS[@]}" 2>&1 | sed 's/^/    /'
  else
    echo "› publishing $pkg"
    npm publish -w "$pkg" "${REG_ARGS[@]}"
  fi
done

echo
if [ "$DRY_RUN" -eq 1 ]; then
  cat <<'EOF'
Dry run only. Nothing was published.

Before publishing for real:
  1. rename the @shashiladev-heshan/ scope to your npm/GitHub org (see docs/PUBLISHING.md)
  2. point .npmrc at your registry and authenticate
  3. re-run with --yes
EOF
else
  echo "published: ${PACKAGES[*]}"
  echo "consumers install with: npm install -g @shashiladev-heshan/govctl@$(node -p "require('./packages/govctl/package.json').version")"
fi
