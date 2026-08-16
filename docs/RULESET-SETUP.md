# Branch ruleset setup

The local hooks and the CLI are convenience. **This page is the security
boundary.** Until a ruleset makes the governance checks required, everything else
is advisory.

Apply to every governed repository, on `main` and `release/*`.

## 1. Create the ruleset

Repository (or org) → Settings → Rules → Rulesets → New branch ruleset.

| Setting | Value | Why |
|---|---|---|
| Enforcement status | **Active** | "Evaluate" mode reports without blocking |
| Target branches | `main`, `release/*` | |
| Restrict deletions | ✅ | |
| Block force pushes | ✅ | Otherwise history can be rewritten around a bad merge |
| Require a pull request before merging | ✅ | GitHub Cloud has no pre-receive hooks; the merge is the gate |
| — Required approvals | **1** (corporate: 2) | |
| — Dismiss stale approvals on push | ✅ | An approval must apply to the code that merges |
| — Require review from Code Owners | ✅ | This is what protects the workflow file itself |
| Require status checks to pass | ✅ | |
| — Require branches to be up to date | ✅ | Prevents a stale branch passing checks against old rules |
| Block force pushes | ✅ | |

## 2. Required status checks

Add all four, exactly as named by the workflow jobs:

```
governance-integrity
governance-lint
governance-patterns
governance-semantic
```

`governance-semantic` is the agent's check. It is required in both tiers — but
what makes it *fail* is tier-dependent: on the startup tier the gate resolves
almost everything to `warn`, so the check passes while still posting findings.
Enforcement lives in the tier YAML, not in whether the check is required.

## 3. Bypass list

Leave it **empty**. If the platform team needs an escape hatch for a false
positive, use the documented override path (below) rather than a standing bypass,
so every override leaves a record.

## 4. Org-level rollout

On GitHub Enterprise Cloud, create the ruleset at organisation level targeting
all repositories with the `governed` custom property, and distribute the workflow
as a **required workflow**. Then the workflow file does not need to exist in each
repo at all, which removes the "delete the workflow" path entirely.

Without Enterprise Cloud, the workflow is templated into each repo by
`govctl init` and protected by CODEOWNERS. Audit it periodically:

```bash
gh repo list your-org --limit 500 --json name -q '.[].name' | while read -r repo; do
  gh api "repos/your-org/$repo/contents/.github/workflows/governance-verify.yml" \
    --silent >/dev/null 2>&1 || echo "MISSING governance workflow: $repo"
done
```

## 5. False-positive escape hatch

A blocking finding that is wrong is a platform-team problem, not a developer
problem. The documented path:

1. Developer applies the `governance-dispute` label and comments with the reason
2. Platform team reviews within one business day
3. If the finding is wrong, the platform team either
   - merges with an admin override **and** opens a registry PR to fix the rule, or
   - ships a rule fix and the developer re-runs the check

Never resolve a dispute by adding the repo to a bypass list — that makes the
false positive permanent and invisible.

## 6. Verifying the setup

Try each of these on a scratch repo before rolling out. All five must fail:

```bash
# 1. direct push to a protected branch
git push origin main

# 2. edit a governed skill and open a PR
echo "# relaxed" >> .governance/skills/error-handling/SKILL.md && git commit -am x

# 3. edit the skill AND regenerate the local manifest to match
#    (integrity re-fetches the canonical manifest from the registry)

# 4. re-sign the manifest with a self-generated key
#    (the key id is not in the trust root)

# 5. delete .github/workflows/governance-verify.yml
#    (CODEOWNERS review required)
```
