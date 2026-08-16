# Development Governance Platform

Centrally managed coding standards, patterns and Claude Code skills — distributed
from one registry, cryptographically verified, and enforced at merge time.

The design principle everything else follows from: **integrity verification and
merge gating are deterministic code. The agent contributes judgement, never
enforcement.**

```
registry (signed releases)
   │  govctl init / sync
   ▼
project/.governance/          ← hash-governed content
   │
   ├─ local:  lefthook + Claude Code guard hook     (advisory, fast)
   └─ CI:     integrity → lint → semgrep → agent    (authoritative)
                  │
                  └─ GitHub Ruleset: all four required, no direct push
```

## What is in this repo

| Path | What it is |
|---|---|
| `packages/policy-core` | Deterministic policy resolution (base → tier → project) and the merge gate |
| `packages/govctl` | The CLI: manifest generation, signing, verification, sync, restore |
| `packages/validator-agent` | Semantic PR reviewer built on the Claude Agent SDK |
| `registry-template/` | A working governance registry: skills, policies, tiers, configs, plugin, release workflows |
| `project-integration/` | What a governed project copies in: CI workflow, CODEOWNERS, ruleset guide |
| `scripts/demo-tamper.sh` | End-to-end walkthrough of the whole trust chain |
| `scripts/pilot-local.sh` | Full rehearsal on real git repos with real hooks |
| `scripts/install-local.sh` | Install the CLIs before private npm exists |
| `scripts/publish.sh` | Publish the packages, in dependency order |
| `docs/` | Developer journey, pilot guide, publishing, signing model, agent design |

This monorepo is the **tooling**. The **registry** is a separate repo created from
`registry-template/` — see [docs/PUBLISHING.md](docs/PUBLISHING.md#repo-topology-first).
They release on different clocks, so a routine rule change cannot alter the code
that enforces rules.

## Try it

```bash
npm install
npm test          # 55 tests: tamper paths, policy resolution, review pipeline
npm run demo      # the trust chain in a temp dir, every tamper attempt blocked
npm run pilot     # a real registry repo + a real project repo, left on disk
```

`npm run demo` proves the trust chain. `npm run pilot` goes further: it creates
two actual git repositories under `pilot/`, installs real git hooks, has a commit
rejected by the pre-commit hook, and runs semgrep and the semantic review over a
real feature branch. Start there — see [docs/PILOT.md](docs/PILOT.md) for taking
it to GitHub with real PRs.

## The trust chain

| Attack | Blocked by |
|---|---|
| Edit a governed skill | Content hash mismatch against the manifest |
| Edit the skill **and** regenerate the manifest | Signature no longer covers the manifest |
| Delete the signature too | `--strict` (CI default) treats a missing signature as failure |
| Re-sign with your own key | Key id is not in the trust root, which CI supplies out-of-band |
| Point the project at a fork | `governance.json` is CODEOWNERS-protected |
| Delete the CI workflow | CODEOWNERS + required-review ruleset |
| Push straight to `main` | Ruleset forbids direct pushes |
| Make the agent approve anything | The agent only emits findings; `gateVerdict` decides, in code |

Each row has a test in `packages/govctl/test/tamper.test.js`.

## Two layers, different jobs

**Local** (`lefthook`, the Claude Code `PreToolUse` guard, `govctl verify`) is for
speed: two seconds instead of a CI round trip. It is bypassable with
`--no-verify`, and that is fine — it was never the security boundary.

**Server** (`governance-verify.yml` + a branch ruleset) is authoritative. It
installs `govctl` from the private registry, takes its trust root from org
configuration, and re-fetches the canonical manifest from the registry — so
nothing inside the pull request influences the outcome.

Note the job ordering in the workflow: `lint`, `semgrep` and `semantic` all
`needs: integrity`, because all three consume content from `.governance/`.
Checking code against rules the PR could have edited proves nothing.

## Tiers

One registry, two postures. `tiers/corporate.yaml` blocks by default with a
two-release staleness window; `tiers/startup.yaml` is advisory-first with a
six-release window, except for the four rules that block everywhere (secrets,
SQL injection, config module, swallowed errors).

Attaching a project to either is one command:

```bash
govctl init --registry https://github.com/your-org/governance.git --tier startup
```

Which rules a project may loosen is a property of the **rule** (`overridable` in
`policy.yaml`), not of the tier — so a tier can never silently contradict what
the skill documentation promises. Weakening a non-overridable rule is refused and
reported; strengthening is always allowed.

## Current status

Working end to end:

- manifest generation, signing, verification, drift detection, restore
- policy resolution + gating, with provenance for every layer that touched a rule
- registry release + validation workflows, project verification workflow
- the review pipeline: diff parsing, rubric loading, prompt assembly, schema-validated
  verdicts, tier-aware gating, PR comment rendering

Stubbed, deliberately, with the seam already in place:

- **Signing** uses a local ed25519 dev signer so the chain is testable offline.
  Production is cosign keyless via GitHub OIDC — see [docs/SIGNING.md](docs/SIGNING.md).
  A `cosign-keyless` bundle is currently *rejected* rather than trusted, so the
  migration cannot silently half-happen.
- **The agent** runs against the real Claude Agent SDK, but has not been
  calibrated. Run it warn-only until the false-positive rate is measured.

Not built yet: the VS Code extension, the Langfuse analytics loop beyond raw
trace emission, and MDM managed-settings distribution.

## Publishing

The packages are publish-ready and were verified against a real registry
(Verdaccio), not just `npm pack` — installed globally from it, with
`@shashiladev-heshan/policy-core` resolving from the registry rather than the workspace, and run
against a governed project.

```bash
bash scripts/publish.sh          # dry run
bash scripts/publish.sh --yes    # for real
```

The scope is currently `@shashiladev-heshan/`, matching the GitHub account
publishing it — GitHub Packages requires the npm scope to equal the owner name.
Moving this to an Allion org later means renaming the scope to match that org and
republishing; the one-liner is in
[docs/PUBLISHING.md](docs/PUBLISHING.md#where-to-publish).
