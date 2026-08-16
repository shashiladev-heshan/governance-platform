# Development Governance Platform

Coding standards that are **centrally managed, cryptographically verified, and
enforced at merge time** — for every project, internal or client-facing.

Standards in a wiki get ignored. Standards copy-pasted into each repo drift.
This makes them a versioned artifact: published once, pulled by every project,
verified on every pull request, and impossible to quietly weaken.

**One principle everything follows from:** integrity verification and merge
gating are deterministic code. The AI contributes judgement, never enforcement.

> Everything you need is in this file. Nothing is hidden in another doc.

---

## Contents

**Getting started**
- [How it works](#how-it-works)
- [The three repositories](#the-three-repositories)
- [Quick start — onboard a repo in 5 minutes](#quick-start--onboard-a-repo-in-5-minutes)
- [Tiers](#tiers)
- [Command reference](#command-reference)
- [A developer's day](#a-developers-day)

**How enforcement works**
- [The CI checks](#the-ci-checks)
- [Why it cannot be bypassed](#why-it-cannot-be-bypassed)
- [The signing model](#the-signing-model)
- [Branch ruleset setup](#branch-ruleset-setup)

**The AI layer**
- [How the assistants learn the standards](#how-the-assistants-learn-the-standards)
- [The AI reviewer](#the-ai-reviewer)

**Operating it**
- [Publishing a new governance release](#publishing-a-new-governance-release)
- [Publishing new tooling packages](#publishing-new-tooling-packages)
- [Repository configuration reference](#repository-configuration-reference)
- [Rolling out](#rolling-out)
- [Troubleshooting](#troubleshooting)
- [What is real and what is not](#what-is-real-and-what-is-not)
- [Repo map](#repo-map)

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

next steps
  1. commit everything written above
  2. npx lefthook install
  3. make the checks required in a branch ruleset:
       governance / governance-integrity
       governance / governance-lint
       governance / governance-patterns
```

What `init` does, step by step:

1. `git ls-remote --tags` the registry, pick the newest semver tag
2. Shallow-clone that tag into a temp dir
3. Check the tier exists — fails early listing valid tiers if you typo'd
4. Copy `skills/`, `policies/`, `tiers/` into `.governance/`
5. Copy `manifest.lock.json` and its signature bundle
6. Hash the manifest itself and record that in `governance.json` — this is what
   later catches someone swapping the manifest rather than editing a rule
7. Write `lefthook.yml`, checking first whether you actually have eslint/prettier
8. Add generated files to `.prettierignore` so a formatter cannot break the hashes
9. Write the CI stub and CODEOWNERS
10. Project the skills into Claude Code and Copilot formats
11. Verify, print the result, delete the temp clone

Then configure the repo ([reference](#repository-configuration-reference)) and add
the [branch ruleset](#branch-ruleset-setup). Those two are one-time repo plumbing
and become org defaults in a full rollout.

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

### What the four skills cover

| Skill | Teaches |
|---|---|
| `nestjs-conventions` | Thin controllers, class-validator DTOs, config module, layered imports |
| `error-handling` | No swallowed errors, typed domain errors, no internal detail in responses |
| `security-baseline` | No hardcoded secrets, parameterised SQL, authorisation on mutations |
| `api-design-patterns` | Versioned routes, one cursor pagination envelope |

Each is a full document with good/bad code pairs and a "reviewer test" — a
one-line question that decides whether the rule fires.

### How a tier resolves

```
base policy (policies/policy.yaml)
   → tier overlay (tiers/<tier>.yaml)
      → project overrides (governance.json)
         = effective policy
```

The tier's `defaults.enforcement` applies to every rule the tier does **not** name
explicitly. That is how `startup` can say "everything is advisory" while pinning
three rules to `block`.

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
promises. Every layer that touched a rule is recorded in a provenance trail.

### Adding a tier

Drop a new `tiers/<name>.yaml` into the registry, cut a release, and projects can
`govctl init --tier <name>`. No code changes. A `pilot.yaml` with
`defaults: { enforcement: warn }` is the usual way to run advisory-only while
calibrating.

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
`--skip-hooks`, `--skip-ci`, `--skip-assistants`, `--force` (re-init in place),
`--lenient` (downgrade missing-signature to a warning), `--skip-staleness`.

`GOVCTL_DEBUG=1` prints full stack traces.

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

> `--tag`, not `--version`: commander reserves `--version` for the CLI itself.

---

## A developer's day

**Writing code.** Claude Code and Copilot already know the standards — they are
loaded from `CLAUDE.md`, `.claude/skills/` and `.github/instructions/`. You get
DTO-validated controllers and typed errors by default, without asking.

**Committing.** `lefthook` runs `govctl verify` plus eslint/prettier on staged
files. Under two seconds, silent when clean:

```
┃  governance ❯
governance verify (local manifest)
  version    v1.2.0   tier corporate
  signature  valid · key allion-platform-signer · signer dev-ed25519
  manifest   bound to governance.json
  content    10 files verified
```

If someone edited a governed file, the commit is rejected:

```
✘ governed file modified: skills/error-handling/SKILL.md
fix: govctl restore
```

**Repairing drift.**

```bash
govctl restore
```

```
✔ restored skills/error-handling/SKILL.md
✔ re-bound governance.json to the v1.2.0 manifest
```

`restore` diffs against the **registry's** manifest, not the local one — so it
also repairs the case where both the file and the manifest were rewritten, which
is exactly the state where a local diff would report everything is fine.

**Checking where you stand.**

```bash
govctl status
```

```
governance status
  registry   https://github.com/shashiladev-heshan/governance.git
  tier       corporate
  version    v1.0.0  (latest v1.3.0)
  staleness  3 release(s) behind, tier allows 2
  rules      10 blocking · 2 advisory · 0 off
  integrity  clean
```

Staleness is enforced, not just displayed: past the window, `governance-integrity`
fails. A hotfix that genuinely cannot wait can use
`verify --remote --strict --skip-staleness`, which skips *only* the freshness
check — every integrity check still applies.

**Opening a PR.** Three or four checks run. Red means fix and push; green means
merge.

---

## The CI checks

All defined **once** in
[`.github/workflows/governance-checks.yml`](.github/workflows/governance-checks.yml)
and called by every project through a six-line stub. Improving the checks is one
edit, not a PR against forty repos.

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

Three details in that workflow that are load-bearing:

- `persist-credentials: false` on the integrity checkout. By default `checkout`
  writes an auth header for **every** github.com URL, which shadows the registry
  credentials and can only read the current repo.
- `scope:` on `setup-node`. Without it, GitHub Packages becomes the default
  registry and every public dependency 404s.
- A **preflight step** that fails with the exact `gh` command when a repo is
  onboarded but unconfigured, instead of npm's opaque `401 Unauthorized`.

---

## Why it cannot be bypassed

Every row has a passing test in
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

Here is the full attack, run for real: edit a skill, regenerate the manifest so
local hashes agree, rebind `governance.json`, delete the signature, push past the
local hooks with `--no-verify`. CI:

```
governance verify (registry manifest)
  canonical  DIFFERS from registry
  content    1 modified · 0 missing · 0 untracked

✘ local manifest does not match the registry at v1.0.0
  (local d4dd021e0971, registry d6d6539f26e8)
✘ governed file modified: skills/error-handling/SKILL.md
```

It never looked at the PR's manifest.

---

## The signing model

### What is signed, and over what bytes

The signature covers the **exact bytes of `manifest.lock.json`**, not a
re-serialisation. The manifest is written with recursively sorted keys, two-space
indent and a trailing newline, so it is byte-stable across machines and Node
versions — which is what makes signing the file itself safe.

### Why the bundle's own public key is not trusted

`manifest.lock.json.bundle` carries a `publicKey`, but verification never uses it
as the source of trust. The order is:

1. **Digest binding** — `sha256(manifest bytes)` must equal `subject.digest`
2. **Trust lookup** — `keyId` must exist in the trust store, and not be revoked
3. **Key binding** — the trust store's key for that id must equal the bundle's key
4. **Signature** — verified against the *trust store's* key

Step 3 is the important one. Without it, an attacker re-signs with a self-generated
keypair, ships the matching public key in the bundle, and everything verifies.
With it:

```
✘ manifest signature invalid: key 'my-own-key' is not in the trust store
```

### Where the trust root comes from

1. `$GOVCTL_TRUST_ROOT` — CI writes this from an org-level variable
2. `~/.govctl/trust.json` — developer machines
3. `<govctl package>/trust/trust.json` — shipped with the CLI, empty by default

Deliberately **not** read from the repository being verified. A repo must never be
able to nominate the key that vouches for its own governance content.

### Current state: local dev signer

```bash
govctl keygen --key-id platform-signer --out signing-key.json --trust
govctl manifest generate --dir . --tag v1.0.0
govctl sign --dir . --key signing-key.json
```

The private key lives in `secrets.GOVERNANCE_SIGNING_KEY`. **This is the weakest
part of the system**: a long-lived key that can be leaked and must be rotated.

### Target state: cosign keyless

The release workflow already requests `id-token: write`. The migration:

1. Replace the signing step:

   ```yaml
   - run: cosign sign-blob --yes --bundle manifest.lock.json.bundle manifest.lock.json
   ```

2. Implement `verifyCosignBundle` in `packages/govctl/src/lib/signing.ts`. It must
   check the **certificate identity** before the signature:
   - issuer is `https://token.actions.githubusercontent.com`
   - subject matches
     `https://github.com/<org>/governance/.github/workflows/release.yml@refs/heads/main`

   Verifying the signature without pinning the identity is close to worthless —
   any GitHub Actions workflow anywhere can produce a valid keyless signature.

3. Replace the trust store's key list with the expected identity constraints.

Until then, `verify` **rejects** any bundle whose signer is `cosign-keyless`
rather than trusting it. A half-finished migration fails closed, loudly.

### Key rotation

1. `govctl keygen --key-id platform-signer-2 --out new-key.json`
2. Add the new public key to the trust root **alongside** the old one, roll it out
3. Cut a release signed with the new key
4. Once every consumer has the new trust root, mark the old key `"status": "revoked"`

Revocation is a status flag rather than a deletion so that "signed by a key we
have since revoked" produces a clear message instead of "unknown key".

### If a key is compromised

1. Mark it revoked in the trust root and push everywhere
2. Re-sign every supported release with a new key
3. Audit registry tags for commits not produced by the release workflow
4. Move the cosign migration forward — a compromised long-lived key is exactly the
   failure mode keyless signing exists to eliminate

---

## Branch ruleset setup

**Until this exists, nothing is enforced.** The checks run and report; merges are
not blocked.

Settings → Rules → Rulesets → New branch ruleset:

| Setting | Value | Why |
|---|---|---|
| Enforcement | **Active** | "Evaluate" reports without blocking |
| Target branches | `main`, `release/*` | |
| Restrict deletions | ✅ | |
| Block force pushes | ✅ | Otherwise history can be rewritten around a bad merge |
| Require a pull request | ✅ | GitHub Cloud has no pre-receive hooks; the merge is the gate |
| — Required approvals | 1 (corporate: 2) | |
| — Dismiss stale approvals on push | ✅ | An approval must apply to the code that merges |
| — Require review from Code Owners | ✅ | **This is what protects the workflow file itself** |
| Require status checks | ✅ | |
| — Require branches to be up to date | ✅ | Prevents a stale branch passing against old rules |

Required checks:

```
governance / governance-integrity
governance / governance-lint
governance / governance-patterns
governance / governance-semantic
```

**The `governance / ` prefix is required.** Reusable workflows namespace job names
under the calling job's id. A ruleset requiring the bare names would never be
satisfied — silently, forever. `govctl init` prints the exact list.

`governance-semantic` is required in both tiers — but what makes it *fail* is
tier-dependent. On startup, the gate resolves almost everything to `warn`, so the
check passes while still posting findings. Enforcement lives in the tier YAML, not
in whether the check is required.

### Bypass list: leave it empty

For a false positive, use the dispute path so every override leaves a record:

1. Developer applies the `governance-dispute` label and comments with the reason
2. Platform team reviews within one business day
3. If the finding is wrong, either merge with an admin override **and** open a
   registry PR to fix the rule, or ship the rule fix and re-run

Never resolve a dispute by adding the repo to a bypass list — that makes the false
positive permanent and invisible.

### Org-level rollout

On GitHub Enterprise Cloud, create the ruleset at **organisation** level targeting
all repos with a `governed` custom property, and distribute the workflow as a
**required workflow**. Then the workflow file does not exist in each repo at all,
which removes the "delete the workflow" path entirely.

Without Enterprise Cloud, the stub is templated by `govctl init` and protected by
CODEOWNERS. Audit periodically:

```bash
gh repo list your-org --limit 500 --json name -q '.[].name' | while read -r repo; do
  gh api "repos/your-org/$repo/contents/.github/workflows/governance.yml" \
    --silent >/dev/null 2>&1 || echo "MISSING governance workflow: $repo"
done
```

### Verify the setup

All five must fail on a scratch repo:

```bash
# 1. direct push to a protected branch
git push origin main

# 2. edit a governed skill and open a PR
# 3. edit the skill AND regenerate the local manifest to match
# 4. re-sign the manifest with a self-generated key
# 5. delete .github/workflows/governance.yml
```

---

## How the assistants learn the standards

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
`.governance/`, which *is* verified. Tamper-proofing a hint file would buy nothing
and make every project fight its own tooling.

`govctl sync` refreshes them **without destroying your own content**:

- Only files carrying govctl's generated marker are ever removed
- Your own skills in `.claude/skills/` and instructions in `.github/instructions/`
  are left alone, and reported
- `CLAUDE.md` and `copilot-instructions.md` are edited **between markers only** —
  everything you wrote around them survives

```markdown
<!-- BEGIN GOVERNED SKILLS (managed by govctl) -->
   ← regenerated on every sync
<!-- END GOVERNED SKILLS (managed by govctl) -->
```

A skill retired from the registry disappears from both tools on the next sync —
otherwise assistants keep teaching a rule the org has withdrawn.

---

## The AI reviewer

The only place an LLM touches this system. Everything about its design follows
from one constraint: **it supplies findings; it does not decide merges.**

### Pipeline

```
PR diff
  └─ parseDiff        drop generated/vendored/.governance paths, keep .ts/.tsx/.js
  └─ chunkFiles       group small related files (~12k chars) so layering rules have context
  └─ loadRubric       only rules whose tier enforcement ≠ off, and only their skills
  └─ buildSystemPrompt  assembled entirely from governed content
  └─ provider.review  Claude Agent SDK, outputFormat: json_schema, no tools
  └─ Zod re-validation
  └─ scope filter     discard findings on files the agent was not shown
  └─ dedupe
  └─ gateVerdict      ← policy-core, deterministic, tier-aware
```

The deterministic layers run first. `semgrep` handles the mechanical cases in its
own job, so the agent never spends tokens on `process.env` reads or empty catch
blocks — it only gets asked what a linter cannot answer.

### Guardrails, and what each one prevents

| Guardrail | Prevents |
|---|---|
| `outputFormat: json_schema` + Zod re-validation | Free-form output reaching the gate |
| Malformed verdict → empty findings **+ degraded** | A parse failure silently reading as "clean" |
| Unknown rule id → warn, never block, listed separately | The agent inventing a blocking rule |
| Findings on unshown files discarded | Hallucinated file paths |
| `allowedTools: []`, `settingSources: []` | The agent reading files the integrity job never verified |
| Chunk budget with named skipped files | A large diff quietly getting a partial review |
| Degraded review cannot report `pass` | Claiming clean for work that was not looked at |
| Diff wrapped in `<diff>`, declared untrusted data | Prompt injection from code, comments or commit text |
| `gate` exits 2 on a missing/unreadable verdict | The check going green because the agent step fell over |

If the agent errors, the API is down, or the verdict file is missing,
`governance-semantic` **fails**. It never passes by default.

### Prompt construction

The system prompt is built only from the resolved policy and the verified
`SKILL.md` bodies. The diff contributes no instructions. Precision is preferred
over recall, on purpose:

> A false positive costs more trust than a missed finding costs quality — the
> deterministic checks catch the mechanical cases anyway. When genuinely unsure,
> stay silent.

### Calibration — before turning blocking on

The gate is tier-driven, so calibration is a policy change, not a code change.

1. Run on pilot repos with every semantic rule at `warn` for two weeks — a
   `tiers/pilot.yaml` with `defaults: { enforcement: warn }` is the easiest way
2. Triage every finding as true/false positive. Findings are attributed to a rule
   id, which is what makes per-rule FP rates measurable
3. Tune the **skill**, not the prompt. A rule producing false positives has an
   ambiguous SKILL.md — add the counter-example that would have prevented it. That
   fix helps Claude Code in the editor too
4. Promote a rule to `block` in `tiers/corporate.yaml` only when its own FP rate is
   under 10%. Per rule, not all at once

Exit criterion: FP < 10% and median review under 4 minutes.

### Cost control

- semgrep pre-filter — mechanical findings cost nothing
- skip list — generated, vendored, lock files, images, `.governance/` itself
- only rules active for the tier enter the rubric
- `GOVERNANCE_MAX_CHUNKS` (default 20) caps agent calls per PR
- concurrency 3, so a large PR is wall-clock bounded

Model defaults to `claude-sonnet-5`; override with `GOVERNANCE_MODEL`.

### Running it without an API key

```bash
GOVERNANCE_AGENT_MODE=mock \
GOVERNANCE_MOCK_VERDICT='{"findings":[{"ruleId":"thin-controllers","severity":"error","file":"src/a.ts","rationale":"..."}]}' \
governance-validator review --diff pr.diff --governance .governance --config governance.json
```

The mock provider runs the entire pipeline — chunking, validation, gating,
rendering. It is how the gate stays testable in CI without spending tokens.

### Tracing

Each chunk emits one event to Langfuse when `LANGFUSE_HOST`,
`LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set: label, tier, version,
finding count, degradation reason, tokens, cost. Fire-and-forget — observability
never fails a PR check. `GOVERNANCE_TRACE_STDOUT=1` prints the same locally.

That trace stream is the input to the calibration loop above.

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

The release workflow validates, regenerates the manifest, signs it, commits, tags
and publishes. **Never tag by hand** — `govctl` reads the manifest from the tagged
tree, so the manifest has to be in that commit. Tagging first would leave the
manifest describing a commit that no longer exists.

Projects pick it up with `govctl sync`. Corporate repos have 2 releases of grace
before CI fails them on staleness; startup repos have 6.

### Doing it manually (what the workflow automates)

```bash
govctl policy validate --dir .
govctl manifest generate --dir . --tag v1.3.0
govctl sign --dir . --key ~/.govctl/signing-key.json
git add -A && git commit -m "governance v1.3.0"
git tag -a v1.3.0 -m "governance v1.3.0" && git push && git push origin v1.3.0
```

### What the registry contains

```
skills/<slug>/SKILL.md      the standards, with good/bad examples
policies/policy.yaml        12 rules: severity, enforcement, overridable, skill
policies/semgrep/*.yaml     deterministic patterns, mapped to rule ids
tiers/*.yaml                per-tier enforcement + staleness window
tests/semgrep/*.ts          fixtures proving each rule still matches
configs/                    @scope/eslint-config, prettier-config, tsconfig
registry.json               governed dirs, CI wiring, assistant wiring
manifest.lock.json          GENERATED: path → sha256
manifest.lock.json.bundle   GENERATED: signature
```

Only `skills/`, `policies/` and `tiers/` are hash-governed and synced into
projects. Lint/format configs go out as npm packages instead, because they must be
resolvable by tooling that knows nothing about govctl.

---

## Publishing new tooling packages

This is how the **verifier itself** changes. Done in `governance-platform`.

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
`govctl@0.3.0` still depends on `policy-core@^0.2.0`, so a fresh install pairs new
gating code with an old policy resolver. That failure is silent and shows up as
inconsistent merge decisions.

Publish order is fixed (`policy-core` first) because npm resolves that dependency
from the registry, not from the workspace. `publish.sh` handles it, runs the tests
first, and refuses to publish a package with no `dist/`.

Then bump `GOVCTL_VERSION` — as an **organisation** variable, so upgrading the
verifier everywhere is one change, and rolling back is the same.

### The packages

| Package | Installed by | Purpose |
|---|---|---|
| `@shashiladev-heshan/govctl` | developers + CI | The CLI |
| `@shashiladev-heshan/governance-validator` | CI only | The AI reviewer |
| `@shashiladev-heshan/policy-core` | nobody directly | Shared policy resolution + gate |

Registry: `https://npm.pkg.github.com` · scope: `@shashiladev-heshan`
Packages: https://github.com/shashiladev-heshan/governance-platform/packages

`policy-core` is a separate package so `govctl status` and the CI gate use **one**
implementation. Two copies could drift, and then a developer's local check and CI
would disagree — and nobody would trust either.

### Where to publish, and the scope constraint

**GitHub Packages** is the least-effort option on GitHub Cloud: private by
default, no extra vendor, access follows repo permissions.

One hard constraint: **the package scope must equal the owner name.** Moving these
to an Allion org means renaming the scope to match and republishing:

```bash
grep -rl '@shashiladev-heshan/' --include='*.json' --include='*.ts' --include='*.js' \
  --include='*.mjs' --include='*.yml' --include='*.md' --include='*.sh' . \
  | grep -v node_modules | grep -v /dist/ | grep -v '^./pilot/' \
  | xargs sed -i '' 's|@shashiladev-heshan/|@allion/|g'
rm -rf node_modules package-lock.json && npm install && npm test
```

Alternatives: a private npmjs org (works behind corporate proxies, costs per
seat), Verdaccio self-hosted (free, one more thing to run), Artifactory.

### Verifying the packaging

Checked against a real registry, not just `npm pack`:

```bash
npx verdaccio@6 --listen 4873 &
npm adduser --registry http://localhost:4873
bash scripts/publish.sh --yes --registry http://localhost:4873
NPM_CONFIG_USERCONFIG=/tmp/npmrc npm i -g --prefix /tmp/gtest \
  --registry http://localhost:4873 @shashiladev-heshan/govctl
/tmp/gtest/bin/govctl --version
```

Worth repeating after any change to `files`, `exports`, or dependency ranges. A
package that installs but cannot resolve `policy-core` still exits 0 on `npm i`
and only fails when someone runs it — which, for a verifier, means it fails in CI
on somebody else's PR.

### Shipping a populated trust root

`packages/govctl/trust/trust.json` ships empty on purpose — an empty store fails
closed with a clear message rather than trusting anything. To have every install
arrive knowing the org key, bake it at publish time:

```yaml
- run: printf '%s' "$TRUST_ROOT" > packages/govctl/trust/trust.json
  env:
    TRUST_ROOT: ${{ vars.GOVERNANCE_TRUST_ROOT }}
```

Trade-off: onboarding becomes a one-liner, but rotating a key then needs a package
release too. CI should keep setting `GOVCTL_TRUST_ROOT` explicitly either way —
CI's trust must not depend on which package version happened to be installed.

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
| `LANGFUSE_HOST` | optional | AI reviewer tracing |

### Secrets

| Name | Value | Used for |
|---|---|---|
| `NPM_READ_TOKEN` | token with `read:packages` | Installing the tooling |
| `GOVERNANCE_REPO_TOKEN` | token with `repo` read | Cloning the registry (it is private) |
| `ANTHROPIC_API_KEY` | Anthropic key | The semantic check. **Missing = the check fails**, deliberately — otherwise deleting one secret silently disables AI review. |
| `GOVERNANCE_SIGNING_KEY` | *registry repo only* | Signing releases |

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

## Rolling out

**Day 1 — see it work locally.**

```bash
git clone https://github.com/shashiladev-heshan/governance-platform.git
cd governance-platform && npm install
npm test          # 77 tests
npm run demo      # every tamper attempt, blocked, in a temp dir
npm run pilot     # a real registry + real project on disk, with real git hooks
```

`npm run pilot` builds two actual git repos, installs real hooks, has a commit
rejected, and runs the checks over a real feature branch. About 30 seconds, and
nothing to break in front of an audience.

**Day 2 — one internal repo.** Push the registry, publish the trust root as an
org variable, `govctl init` one repo, open PRs **without** a ruleset and watch the
checks report.

**Week 1 — make it binding.** Apply the ruleset to that one repo. Run the AI
reviewer warn-only via a `pilot` tier.

**Weeks 2–3 — calibrate.** Triage every agent finding. Fix the *skills*, not the
prompt.

**Then — widen.** Promote rules to `block` one at a time. Roll out to more repos,
corporate tier first, then startup on the advisory tier.

### Before rolling out widely

- **Move to cosign keyless.** The dev signer means a long-lived private key in a
  repo secret.
- **Rename the scope** to your org before the first publish, not after.
- **Replace CODEOWNERS placeholders** with the real team.
- **Write skills from your own codebases.** The four here are worked examples with
  real good/bad pairs, but they are not your conventions until someone senior has
  read them line by line.

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
| `nothing added to commit but untracked files` | `git commit -am` only stages *tracked* files | `git add -A` first |
| Reusable workflow not found | A public repo cannot call a private repo's reusable workflow (personal accounts) | Make the platform repo public, or use an org |

Full verbose output: `GOVCTL_DEBUG=1 govctl verify`.

---

## What is real and what is not

**Working, tested, and run end to end against real GitHub infrastructure:**

- manifest generation, signing, verification, drift detection, restore
- policy resolution and gating, with provenance for every layer that touched a rule
- registry release + validation workflows; the shared project workflow
- the AI review pipeline: diff parsing, rubric loading, schema-validated verdicts,
  tier-aware gating, PR comments
- AI assistant wiring for Claude Code and Copilot
- 77 automated tests, including every tamper path

**Deliberately stubbed, with the seam already in place:**

- **Signing uses a local ed25519 dev key**, not cosign keyless. Anyone holding
  `signing-key.json` can forge a manifest. See
  [the signing model](#target-state-cosign-keyless).
- **The AI reviewer is uncalibrated.** It runs, but has never been measured against
  real PRs. Warn-only until FP < 10%.
- **The four skills are worked examples, not Allion's conventions.**

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
scripts/publish.sh          publish the packages, in dependency order
scripts/install-local.sh    install the CLIs from source, pre-registry
```

### Live examples

| | |
|---|---|
| A working governed project | https://github.com/shashiladev-heshan/billing-service |
| A blocked PR | https://github.com/shashiladev-heshan/governance-pilot-service/pull/1 |
