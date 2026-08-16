# Project integration

What a governed repository needs, beyond what `govctl init` writes for it.

`govctl init` produces `governance.json`, `.governance/` and `lefthook.yml`. Those
are the advisory layer. The files here are the authoritative one.

| File | Copy to | Purpose |
|---|---|---|
| `.github/workflows/governance-verify.yml` | `.github/workflows/` | The four required checks |
| `CODEOWNERS` | `.github/CODEOWNERS` | Protects the workflow, `governance.json` and `.governance/` |

Then apply the branch ruleset — [docs/RULESET-SETUP.md](../docs/RULESET-SETUP.md).
Until that exists, the workflow runs but nothing is required, and nothing is
actually enforced.

## Repository configuration the workflow expects

**Variables**

| Name | Value |
|---|---|
| `NPM_REGISTRY_URL` | Private npm registry (defaults to npmjs.org) |
| `GOVCTL_VERSION` | Pinned `@shashiladev-heshan/govctl` version (defaults to `latest`) |
| `VALIDATOR_VERSION` | Pinned `@shashiladev-heshan/governance-validator` version |
| `GOVERNANCE_TRUST_ROOT` | The trust store JSON, as an org-level variable |
| `LANGFUSE_HOST` | Optional, for agent tracing |

**Secrets**

| Name | Purpose |
|---|---|
| `NPM_READ_TOKEN` | Installing the private packages |
| `ANTHROPIC_API_KEY` | The semantic review job |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | Optional tracing |

Set `GOVERNANCE_TRUST_ROOT` at the **organisation** level, not per repository. A
repo that can edit its own trust root can vouch for its own governance content,
which defeats the point.

## Rolling out at scale

On GitHub Enterprise Cloud, distribute `governance-verify.yml` as an org-level
**required workflow** targeting repositories with a `governed` custom property.
Then the file does not live in each repo at all, and "delete the workflow" stops
being a path worth defending against.

Without Enterprise Cloud, each repo gets its own copy and CODEOWNERS protects it.
Audit periodically with the script in
[docs/RULESET-SETUP.md](../docs/RULESET-SETUP.md#4-org-level-rollout).
