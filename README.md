# Development Governance Platform

Coding standards that are **centrally managed, cryptographically verified, and
enforced at merge time** — for every project, internal or client-facing.

Standards in a wiki get ignored. Standards copy-pasted into each repo drift.
This makes them a versioned artifact: published once, pulled by every project,
verified on every pull request, and impossible to quietly weaken.

**One principle everything follows from:** integrity verification and merge
gating are deterministic code. The AI contributes judgement, never enforcement.

---

## Table of contents

- [How it works](#how-it-works)
- [The three repositories](#the-three-repositories)
- [Quick start — onboard a repo in 5 minutes](#quick-start--onboard-a-repo-in-5-minutes)
- [Tiers](#tiers)
- [Command reference](#command-reference)
- [A developer's day](#a-developers-day)
- [The CI checks](#the-ci-checks)
- [Why it cannot be bypassed](#why-it-cannot-be-bypassed)
- [How the AI assistants learn the standards](#how-the-ai-assistants-learn-the-standards)
- [Publishing a new governance release](#publishing-a-new-governance-release)
- [Publishing new tooling packages](#publishing-new-tooling-packages)
- [Repository configuration reference](#repository-configuration-reference)
- [Branch ruleset setup](#branch-ruleset-setup)
- [Troubleshooting](#troubleshooting)
- [What is real and what is not](#what-is-real-and-what-is-not)

---

## How it works

```
┌──────────────────────────────────────────────────────────────────────────┐
│  GOVERNANCE REGISTRY          github.com/shashiladev-heshan/governance   │
│                                                                          │
│  skills/       the standards, taught with good/bad examples              │
│  policies/     12 rules + semgrep patterns                               │
│  tiers/        corporate.yaml · startup.yaml                             │
│  manifest.lock.json + .bundle    SHA-256 of every file, signed           │
│                                                                          │
│  Released as git tags:  v1.0.0 → v1.1.0 → v1.2.0                         │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │  govctl init / govctl sync
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  YOUR PROJECT                                                            │
│                                                                          │
│  governance.json        registry URL · tier · pinned version · digest    │
│  .governance/           ← VERIFIED. Editing this blocks your merge.      │
│                                                                          │
│  ── generated from .governance/, safe to edit, refreshed on sync ──      │
│  CLAUDE.md                      Claude Code reads this every session     │
│  .claude/skills/                Claude Code loads these on demand        │
│  .github/copilot-instructions.md    Copilot reads this repo-wide         │
│  .github/instructions/          Copilot loads these by file glob         │
│  lefthook.yml                   pre-commit + pre-push hooks              │
│  .github/workflows/governance.yml   6-line stub → shared workflow        │
└───────────────┬────────────────────────────────┬─────────────────────────┘
                │                                │
        LOCAL (fast, advisory)          SERVER (authoritative)
        ~2 seconds, bypassable          the actual gate
                │                                │
                ▼                                ▼
   ┌────────────────────────┐   ┌───────────────────────────────────────┐
   │ git commit             │   │ pull request                          │
   │  └ govctl verify       │   │  ├ governance-integrity   hashes+sig   │
   │  └ eslint / prettier   │   │  ├ governance-lint        eslint       │
   │                        │   │  ├ governance-patterns    semgrep      │
   │ bypass: --no-verify    │   │  └ governance-semantic    AI review    │
   └────────────────────────┘   │                                       │
                                │ Branch ruleset: all required,         │
                                │ no direct push to main                │
                                └───────────────────────────────────────┘
```

**Local is for speed. Server is for truth.** A developer can skip the local hooks
with `--no-verify` — that is fine and intended. The pull request re-downloads the
standards from the registry and ignores whatever is in the branch.

---

## The three repositories

| Repo | What it is | Who touches it |
|---|---|---|
| [`governance`](https://github.com/shashiladev-heshan/governance) | **The registry.** Skills, rules, tiers. Released as signed git tags. | Platform team, via PR |
| [`governance-platform`](https://github.com/shashiladev-heshan/governance-platform) | **The tooling.** `govctl`, policy engine, AI validator, the shared CI workflow. | Platform team |
| your project | Consumes both. | Every developer |

They release on **different clocks** on purpose. The registry ships new rules
every week or two; the tooling ships rarely. Keeping them apart means a routine
rule change cannot accidentally alter the code that enforces rules.

---

## Quick start — onboard a repo in 5 minutes

### Once per machine

Add GitHub Packages to `~/.npmrc` (the **user** config — `npm i -g` ignores a
project-level `.npmrc`):

```bash
cat >> ~/.npmrc <<EOF
@shashiladev-heshan:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=$(gh auth token)
EOF
```

Install the CLI and the signing trust root:

```bash
npm i -g @shashiladev-heshan/govctl
govctl --version                      # 0.2.2

# ask the platform team for trust.json — without it, signature checks fail
mkdir -p ~/.govctl && cp <trust.json> ~/.govctl/trust.json
```

### Per project

```bash
cd my-service

govctl init --registry https://github.com/shashiladev-heshan/governance.git \
            --tier corporate

npm i -D lefthook && npx lefthook install
git add -A && git commit -m "chore: attach governance"
```

That is it. `init` writes everything:

```
✔ replaced the empty lefthook.yml stub with the governance hooks
✔ written .prettierignore (.governance/, lefthook.yml, governance.json)
✔ wrote .github/workflows/governance.yml
✔ wrote .github/CODEOWNERS
✔ wired 4 skill(s) into .claude/skills + CLAUDE.md
✔ wired 4 instruction file(s) into .github/instructions
✔ initialized governance v1.2.0 (tier: corporate)
```

Then configure the repo ([reference below](#repository-configuration-reference))
and add the [branch ruleset](#branch-ruleset-setup). Those two are one-time repo
plumbing and become org defaults in a full rollout.

---

## Tiers

One registry, two postures. The tier decides **how hard each rule bites**, not
which rules exist.

| | **corporate** | **startup** |
|---|---|---|
| Posture | Blocking by default | Advisory-first |
| Blocking rules | 10 of 12 | 3 of 12 |
| Staleness window | 2 releases | 6 releases |
| Use for | Corporate client engagements, audited work | Startup client work, early-stage products |

### Every rule, and what each tier does with it

| Rule | Skill | corporate | startup |
|---|---|---|---|
| `no-hardcoded-secrets` | security-baseline | **block** | **block** |
| `no-raw-sql-interpolation` | security-baseline | **block** | **block** |
| `config-module-only` | nestjs-conventions | **block** | **block** |
| `authz-on-mutations` | security-baseline | **block** | warn |
| `dto-validation` | nestjs-conventions | **block** | warn |
| `thin-controllers` | nestjs-conventions | **block** | warn |
| `layered-imports` | nestjs-conventions | **block** | warn |
| `no-swallowed-errors` | error-handling | **block** | warn |
| `typed-domain-errors` | error-handling | **block** | warn |
| `no-error-detail-leak` | error-handling | **block** | warn |
| `api-versioned-routes` | api-design-patterns | warn | warn |
| `api-consistent-pagination` | api-design-patterns | warn | warn |

**Three rules block in every tier**, including startup: committed secrets, SQL
injection, and scattered `process.env` reads. The first two are incidents, not
style. The third is what makes a client handover impossible.

**Two rules are advisory in every tier**: route versioning and pagination shape.
They are judgement calls, and blocking a 2am hotfix over a route prefix is worse
than the inconsistency.

### Project-level overrides

A project can loosen a rule **only** if the rule is marked `overridable` in the
base policy — `layered-imports` is the only one today.

```json
// governance.json
{
  "overrides": { "rules": { "layered-imports": { "enforcement": "warn" } } }
}
```

Attempting to loosen anything else is refused and reported in CI. Tightening is
always allowed. Whether a rule may be loosened is a property of the **rule**, not
the tier — so a tier can never silently contradict what the skill documentation
promises.

---

## Command reference

### For developers

| Command | What it does |
|---|---|
| `govctl init --registry <url> --tier <tier>` | Attach a project. Writes `.governance/`, hooks, CI stub, AI wiring. |
| `govctl status` | Version, tier, staleness, rule counts, drift. Start here. |
| `govctl verify` | Check the governed content is intact. What the pre-commit hook runs. |
| `govctl sync` | Update to the newest governance release. |
| `govctl sync --tag v1.1.0` | Move to a specific release (or roll back). |
| `govctl restore` | Repair edited/missing governed files from the registry. |
| `govctl restore --prune` | Also delete rogue files added under `.governance/`. |

Useful flags: `--json` (machine-readable), `--tag` (pin a release),
`--skip-hooks`, `--skip-ci`, `--skip-assistants`, `--force` (re-init in place).

### For CI

| Command | What it does |
|---|---|
| `govctl verify --remote --strict` | The authoritative check. Fetches the canonical manifest from the registry and ignores the copy in the PR. |
| `governance-validator review --diff pr.diff ...` | Runs the AI reviewer, writes `verdict.json` + `verdict.md`. |
| `governance-validator gate --verdict verdict.json` | Turns the verdict into the check result. |

### For the platform team (registry side)

| Command | What it does |
|---|---|
| `govctl policy validate --dir .` | Schema-check `policy.yaml`, resolve every tier. Run on every registry PR. |
| `govctl manifest generate --dir . --tag v1.3.0` | Hash all governed files. |
| `govctl manifest check --dir .` | Fail if the committed manifest is stale. |
| `govctl sign --dir . --key <key.json>` | Sign the manifest. |
| `govctl keygen --key-id <id> --out <file> --trust` | Create a signing key (dev signer). |
| `govctl trust add --key <pub.json>` | Trust a signing key on this machine. |
| `govctl trust list` | Show the trust store in use. |

---

## A developer's day

**Writing code.** Claude Code and Copilot already know the standards — they are
loaded from `CLAUDE.md`, `.claude/skills/` and `.github/instructions/`. You get
DTO-validated controllers and typed errors by default, without asking.

**Committing.** `lefthook` runs `govctl verify` plus eslint/prettier on staged
files. Under two seconds, silent when clean. If someone edited a governed file:

```
✘ governed file modified: skills/error-handling/SKILL.md
fix: govctl restore
```

**Opening a PR.** Three or four checks run ([below](#the-ci-checks)). Red means
fix and push; green means merge.

**When the standards change.** The platform team ships `v1.3.0`; you run
`govctl sync`. `govctl status` warns when you fall outside the tier's staleness
window — and CI fails once you exceed it.

---

## The CI checks

All defined **once** in
[`governance-checks.yml`](.github/workflows/governance-checks.yml) and called by
every project through a six-line stub. Improving the checks is one edit, not a PR
against forty repos.

```yaml
# .github/workflows/governance.yml — written by govctl init
jobs:
  governance:
    uses: shashiladev-heshan/governance-platform/.github/workflows/governance-checks.yml@main
    secrets: inherit
    with:
      run-lint: true
      run-semantic: false
```

| Check | What it proves |
|---|---|
| `governance-integrity` | The standards in this PR are byte-identical to the signed registry release, and the release is fresh enough for the tier. |
| `governance-lint` | eslint + prettier pass (`npm ci` first, so a patched local `node_modules` changes nothing). |
| `governance-patterns` | semgrep found no mechanical violations — secrets, raw SQL, `process.env`, empty catch. |
| `governance-semantic` | The AI reviewer found no blocking violations of the pattern skills. |

**Ordering is part of the design.** `lint`, `patterns` and `semantic` all
`needs: integrity`, because all three consume content from `.governance/`.
Checking code against rules the PR could have edited proves nothing.

---

## Why it cannot be bypassed

Every row here has a passing test in
[`packages/govctl/test/tamper.test.js`](packages/govctl/test/tamper.test.js), and
every one was also run for real against GitHub during the pilot.

| Attempt | What stops it |
|---|---|
| Edit a governed skill | Content hash mismatch |
| Edit the skill **and** regenerate the manifest | The release signature no longer covers the manifest |
| Delete the signature too | `--strict` (CI default) treats a missing signature as failure |
| Re-sign with your own key | The key id is not in the trust root, which CI supplies out-of-band |
| Add a rogue skill granting exemptions | Caught as untracked content |
| Delete a rule file | Caught as missing content |
| Point `governance.json` at your own fork | CODEOWNERS-protected |
| Delete the CI workflow | CODEOWNERS + required-review ruleset |
| Push straight to `main` | Ruleset forbids direct pushes |
| Make the AI approve anything | It only emits findings; deterministic code decides. An invented rule id can never block. |

The signature check is the subtle one. The bundle ships its own public key, but
verification looks the key up in the **trust root by id** and requires an exact
match. Swapping in a self-generated keypair fails at the lookup:

```
✘ manifest signature invalid: key 'my-own-key' is not in the trust store
```

---

## How the AI assistants learn the standards

`.governance/` is not a path Claude Code or Copilot scans. So `govctl` projects
the governed skills into each tool's own convention:

| File | Read by | Contents |
|---|---|---|
| `CLAUDE.md` | Claude Code, every session | Short index — skill names + descriptions |
| `.claude/skills/<slug>/SKILL.md` | Claude Code, on demand | Full rule text with good/bad examples |
| `.github/copilot-instructions.md` | Copilot, repo-wide | Short index |
| `.github/instructions/<slug>.instructions.md` | Copilot, by `applyTo` glob | Full rule text |

Each skill declares its own glob, so `nestjs-conventions` only loads for
`*.controller.ts`, `*.service.ts`, `*.module.ts`, `*.dto.ts`.

**These files are not verified, and that is deliberate.** A developer can edit
them. The blast radius is "your AI gives you worse advice" — the merge gate reads
`.governance/`, which *is* verified. Tamper-proofing a hint file would buy
nothing and make every project fight its own tooling.

`govctl sync` refreshes them **without destroying your own content**:

- Only files carrying govctl's generated marker are ever removed
- Your own skills in `.claude/skills/` and instructions in `.github/instructions/` are left alone
- `CLAUDE.md` and `copilot-instructions.md` are edited **between markers only** — everything you wrote around them survives

```markdown
<!-- BEGIN GOVERNED SKILLS (managed by govctl) -->
   ← regenerated on every sync
<!-- END GOVERNED SKILLS (managed by govctl) -->
```

---

## Publishing a new governance release

This is how a **standard** changes — a new rule, a reworded skill, a tier
adjustment. Done in the `governance` repo.

```bash
git clone https://github.com/shashiladev-heshan/governance.git
cd governance
git checkout -b feat/require-idempotency-keys
```

1. **Edit the content** — a skill in `skills/`, a rule in `policies/policy.yaml`,
   a pattern in `policies/semgrep/`, or a tier in `tiers/`.
2. **Add a fixture** if you touched semgrep — `tests/semgrep/<name>.ts`, with
   `// ruleid: <rule>` above a violation and `// ok: <rule>` above a clean case.
   A rule that silently stops matching is worse than one that fails to parse.
3. **Validate locally:**

   ```bash
   govctl policy validate --dir .
   semgrep --test --config policies/semgrep/ tests/semgrep/
   ```

4. **Open a PR.** `validate-registry.yml` re-runs both, plus `manifest check`.
5. **Release:** Actions → **release** → Run workflow → `v1.3.0`

The release workflow validates, regenerates the manifest, signs it, commits,
tags and publishes. **Never tag by hand** — `govctl` reads the manifest from the
tagged tree, so the manifest has to be in that commit.

Projects pick it up with `govctl sync`. Corporate-tier repos have 2 releases of
grace before CI fails them on staleness; startup repos have 6.

### Doing it manually (what the workflow automates)

```bash
govctl policy validate --dir .
govctl manifest generate --dir . --tag v1.3.0
govctl sign --dir . --key ~/.govctl/signing-key.json
git add -A && git commit -m "governance v1.3.0"
git tag -a v1.3.0 -m "governance v1.3.0" && git push && git push origin v1.3.0
```

---

## Publishing new tooling packages

This is how the **verifier itself** changes — new `govctl` behaviour, a fix to
the policy engine. Done in `governance-platform`.

```bash
npm test                                    # 77 tests must pass

node scripts/sync-internal-deps.mjs 0.3.0   # ← not optional, see below
npm version 0.3.0 --no-git-tag-version --workspaces
npm install --package-lock-only

bash scripts/publish.sh                     # dry run
bash scripts/publish.sh --yes               # publish
```

Or Actions → **publish** → Run workflow.

`sync-internal-deps.mjs` is not optional. `npm version --workspaces` bumps each
package's own version but leaves dependency *ranges* alone — without it,
`govctl@0.3.0` still depends on `policy-core@^0.2.0`, so a fresh install pairs
new gating code with an old policy resolver. That failure is silent and shows up
as inconsistent merge decisions.

Publish order is fixed (`policy-core` first) because npm resolves that dependency
from the registry, not from the workspace. `publish.sh` handles it.

Then bump `GOVCTL_VERSION` — as an **organisation** variable, so upgrading the
verifier everywhere is one change, and rolling back is the same.

### The packages

| Package | Installed by | Purpose |
|---|---|---|
| [`@shashiladev-heshan/govctl`](https://github.com/shashiladev-heshan/governance-platform/pkgs/npm/govctl) | developers + CI | The CLI |
| [`@shashiladev-heshan/governance-validator`](https://github.com/shashiladev-heshan/governance-platform/pkgs/npm/governance-validator) | CI only | The AI reviewer |
| [`@shashiladev-heshan/policy-core`](https://github.com/shashiladev-heshan/governance-platform/pkgs/npm/policy-core) | nobody directly | Shared policy resolution + gate |

Registry: `https://npm.pkg.github.com` · scope: `@shashiladev-heshan`

`policy-core` is a separate package so that `govctl status` and the CI gate use
**one** implementation. Two copies could drift, and then a developer's local
check and CI would disagree — and nobody would trust either.

---

## Repository configuration reference

### Variables

| Name | Value | Why |
|---|---|---|
| `GOVERNANCE_TRUST_ROOT` | contents of `trust.json` | The public signing key. **Set at org level** — a repo that can edit its own trust root can vouch for its own content. |
| `NPM_REGISTRY_URL` | `https://npm.pkg.github.com` | |
| `NPM_SCOPE` | `@shashiladev-heshan` | Without it, setup-node makes this the default registry and every public dependency 404s |
| `GOVCTL_VERSION` | e.g. `0.2.2` | Pin it. `latest` means CI changes under you. |
| `VALIDATOR_VERSION` | e.g. `0.2.2` | |

### Secrets

| Name | Value | Used for |
|---|---|---|
| `NPM_READ_TOKEN` | token with `read:packages` | Installing the tooling |
| `GOVERNANCE_REPO_TOKEN` | token with `repo` read | Cloning the registry (it is private) |
| `ANTHROPIC_API_KEY` | Anthropic key | The semantic check. **Missing = the check fails**, deliberately — otherwise deleting one secret silently disables AI review. |

```bash
R=your-org/your-repo
gh variable set GOVERNANCE_TRUST_ROOT --repo $R --body "$(cat ~/.govctl/trust.json)"
gh variable set NPM_REGISTRY_URL      --repo $R --body "https://npm.pkg.github.com"
gh variable set NPM_SCOPE             --repo $R --body "@shashiladev-heshan"
gh variable set GOVCTL_VERSION        --repo $R --body "0.2.2"
gh secret   set NPM_READ_TOKEN        --repo $R --body "$(gh auth token)"
gh secret   set GOVERNANCE_REPO_TOKEN --repo $R --body "$(gh auth token)"
```

---

## Branch ruleset setup

**Until this exists, nothing is enforced.** The checks run and report; merges are
not blocked.

Settings → Rules → Rulesets → New branch ruleset:

- Enforcement **Active**, target `main` (and `release/*`)
- ✅ Restrict deletions · ✅ Block force pushes
- ✅ Require a pull request — 1 approval (2 for corporate clients)
- ✅ Dismiss stale approvals on push
- ✅ Require review from Code Owners ← *this is what protects the workflow file*
- ✅ Require status checks, **branches must be up to date**:

```
governance / governance-integrity
governance / governance-lint
governance / governance-patterns
governance / governance-semantic
```

**The `governance / ` prefix is required.** Reusable workflows namespace their
job names under the calling job's id. A ruleset requiring the bare names would
never be satisfied — silently, forever. `govctl init` prints the exact list.

Leave the bypass list **empty**. For a false positive, use the dispute path
(label `governance-dispute` → platform team reviews) so every override leaves a
record, rather than a standing bypass that makes the problem permanent and
invisible.

---

## Troubleshooting

Every one of these was hit for real during the pilot.

| Symptom | Cause | Fix |
|---|---|---|
| `401 Unauthorized ... authentication token not provided` | Repo variables/secrets never set | Run the config block above. Newer versions catch this in a preflight step and name the missing setting. |
| `404 Not Found - GET https://registry.npmjs.org/@scope%2fgovctl` | `.npmrc` in the project instead of `~/.npmrc` | `npm i -g` ignores project-level npmrc. Use the user config. |
| `git ls-remote failed` in CI | `actions/checkout` persisted an auth header that shadows the registry credentials | Already fixed in the shared workflow (`persist-credentials: false`) |
| `lefthook.yml` is all comments | `npm i -D lefthook` postinstall wrote a stub before `govctl init` | `govctl init --force` (0.1.1+ replaces the stub automatically) |
| Prettier fails on `lefthook.yml` | Its quote style cannot match every project | 0.1.2+ adds it to `.prettierignore` |
| `command not found: govctl` in the hook | Not installed on that machine | `npm i -g @shashiladev-heshan/govctl` |
| `cannot verify manifest signature: no trust root configured` | No `~/.govctl/trust.json` | Get it from the platform team |
| `governance is stale: pinned v1.0.0, latest v1.3.0` | Outside the tier's window | `govctl sync` |
| Ruleset never satisfied | Required check names missing the `governance / ` prefix | Use the names `govctl init` printed |
| Required checks show 0 runs | The workflow is `on: pull_request` only | Open a PR — a push to `main` triggers nothing |

Full verbose output: `GOVCTL_DEBUG=1 govctl verify`.

---

## What is real and what is not

**Working, tested, and run end to end against real GitHub infrastructure:**

- manifest generation, signing, verification, drift detection, restore
- policy resolution and gating, with provenance for every layer that touched a rule
- registry release + validation workflows; the shared project workflow
- the AI review pipeline: diff parsing, rubric loading, schema-validated verdicts, tier-aware gating, PR comments
- AI assistant wiring for Claude Code and Copilot
- 77 automated tests, including every tamper path

**Deliberately stubbed, with the seam already in place:**

- **Signing uses a local ed25519 dev key**, not cosign keyless. Anyone holding
  `signing-key.json` can forge a manifest. Production is cosign keyless via
  GitHub OIDC — see [docs/SIGNING.md](docs/SIGNING.md). A `cosign-keyless` bundle
  is currently *rejected* rather than trusted, so the migration cannot silently
  half-happen.
- **The AI reviewer is uncalibrated.** It runs, but has never been measured
  against real PRs. Run it warn-only until the false-positive rate is under 10% —
  see [docs/AGENT.md](docs/AGENT.md#calibration--before-turning-blocking-on).
- **The four skills are worked examples, not Allion's conventions.** They contain
  real good/bad pairs, but someone senior needs to read them line by line before
  they mean anything.

**Not built:** VS Code extension, Langfuse analytics loop beyond raw traces, MDM
managed-settings distribution.

**Personal-account limitations** that disappear in a GitHub org: private repos
cannot share reusable workflows, branch rulesets need Pro on private repos, and
org-level required workflows (which remove the per-repo stub entirely) need
Enterprise Cloud.

---

## Repo map

```
packages/policy-core/       policy resolution (base → tier → project) + the gate
packages/govctl/            the CLI
packages/validator-agent/   the AI reviewer
registry-template/          a working registry: skills, policies, tiers, configs
project-integration/        reference workflow + CODEOWNERS
.github/workflows/          governance-checks.yml (shared), publish.yml
scripts/demo-tamper.sh      the trust chain in a temp dir, every attack blocked
scripts/pilot-local.sh      full rehearsal on real git repos with real hooks
docs/                       developer journey, pilot, publishing, signing, agent
```

### Try it without touching anything

```bash
git clone https://github.com/shashiladev-heshan/governance-platform.git
cd governance-platform && npm install
npm test          # 77 tests
npm run demo      # every tamper attempt, blocked, in a temp dir
npm run pilot     # a real registry + real project, left on disk to poke at
```

### Further reading

| Doc | For |
|---|---|
| [docs/DEVELOPER-JOURNEY.md](docs/DEVELOPER-JOURNEY.md) | Day-by-day, with real output |
| [docs/PILOT.md](docs/PILOT.md) | Rolling out to a first real repo |
| [docs/PUBLISHING.md](docs/PUBLISHING.md) | Package publishing in depth |
| [docs/SIGNING.md](docs/SIGNING.md) | The trust model and the cosign migration |
| [docs/AGENT.md](docs/AGENT.md) | AI reviewer design, guardrails, calibration |
| [docs/RULESET-SETUP.md](docs/RULESET-SETUP.md) | Branch protection, in detail |
