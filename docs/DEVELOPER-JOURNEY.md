# What this looks like to a developer starting a new project

Every command below is real and every output is copied from an actual run
(`npm run demo` reproduces it). Paths are shortened for readability.

---

## Day 1 — attaching the project

One command, run once by whoever creates the repo:

```bash
npm i -g @shashiladev-heshan/govctl
govctl init --registry https://github.com/your-org/governance.git --tier corporate
```

What `govctl init` does, in order:

1. `git ls-remote --tags` the registry and picks the newest semver tag
2. shallow-clones that tag into a temp dir
3. copies `skills/`, `policies/`, `tiers/` into `.governance/`
4. copies `manifest.lock.json` and its signature bundle alongside them
5. records the manifest's own SHA-256 in `governance.json` — this is what later
   detects someone swapping the manifest rather than editing a file
6. writes `lefthook.yml` wiring `govctl verify` into pre-commit and pre-push
7. runs a verification pass and prints the result

```
› resolving version from https://github.com/your-org/governance.git
› fetching v1.0.0
governance verify (local manifest)
  version    v1.0.0   tier corporate
  signature  valid · key platform-signer · signer dev-ed25519
  manifest   bound to governance.json
  content    10 files verified

✔ initialized governance v1.0.0 (tier: corporate)

next steps
  1. commit governance.json, .governance/ and lefthook.yml
  2. copy .github/workflows/governance-verify.yml + CODEOWNERS from the registry
  3. apply the branch ruleset (see docs/RULESET-SETUP.md) so the checks are required
  4. extend @shashiladev-heshan/eslint-config in your eslint config
```

The repo now contains:

```
governance.json                 # registry, tier, pinned version, manifest digest
.governance/
  skills/                       # nestjs-conventions, error-handling, api-design, security-baseline
  policies/policy.yaml
  policies/semgrep/*.yaml
  tiers/corporate.yaml
  manifest.lock.json
  manifest.lock.json.bundle
lefthook.yml
```

All of it gets committed. Steps 2 and 3 are the ones that actually matter for
enforcement — until the ruleset exists, everything is advisory.

**Time: under five minutes.**

---

## Day 2 onwards — writing code

**In the editor.** Claude Code has the governed skills loaded from the plugin
marketplace, so it writes DTO-validated controllers and typed domain errors by
default — the standards are in its context, not in a wiki nobody opens. The
plugin's `PreToolUse` hook refuses any tool call that would edit `.governance/`,
so an agent cannot "helpfully" relax a rule while fixing something else.

**On commit.** `lefthook` runs `govctl verify` plus eslint and prettier on staged
files. Clean repo, under two seconds, silent. If a governed file was edited:

```
✘ governed file modified: skills/error-handling/SKILL.md

fix: govctl restore   (or 'govctl sync' to move to a newer release)
```

A developer can bypass this with `git commit --no-verify`. By design — the local
layer is for speed, not security.

---

## Opening the PR — where it is actually enforced

Four required checks, and the ordering matters:

**`governance-integrity`** installs `govctl` fresh from the private npm registry
(not from the PR's `node_modules`), loads its trust root from org configuration
(not from the repo), and runs:

```bash
govctl verify --remote --strict
```

`--remote` re-fetches the canonical manifest from the registry and ignores the
copy in the PR entirely. `--strict` makes an absent or unverifiable signature a
failure rather than a warning.

**`governance-lint`** runs `npm ci` first, so `@shashiladev-heshan/eslint-config` is reinstalled
from the lockfile and a locally patched `node_modules` changes nothing.

**`governance-patterns`** runs the semgrep rules from `.governance/policies/semgrep/`
— which the integrity job has just proved match the registry byte for byte.

**`governance-semantic`** is the agent. It gets the PR diff, the tier-resolved
policy, and the verified skills as its rubric, and returns findings through a
JSON schema. `gateVerdict` in `policy-core` — plain code — turns those findings
into pass/warn/block according to the tier.

All four are required status checks, and the ruleset forbids direct pushes to
`main`. The only way code lands is a PR where all four are green.

---

## What happens when someone tries to get around it

Each of these is a passing test in `packages/govctl/test/tamper.test.js`.

**Edit a governed skill.** Content hash mismatch:

```
✘ governed file modified: skills/error-handling/SKILL.md
```

**Edit the skill and regenerate the manifest so hashes agree.** The release
signature still covers the original manifest, and an invalid signature is fatal in
every mode — this one does not even reach CI:

```
✘ manifest signature invalid: signature covers a different manifest
  (bundle says 22f8c2f7ec40, actual 687d90744b09)
```

**Delete the signature too.** Now local `verify` passes with a warning — the local
layer really is fooled. CI runs `--strict`:

```
✘ no signature bundle (manifest.lock.json.bundle) found for the manifest
```

**Re-sign with a self-generated key.** The bundle carries its own public key, but
verification looks the key up in the trust root by id and requires an exact match:

```
✘ manifest signature invalid: key 'my-own-key' is not in the trust store
```

**All of the above at once.** CI never reads the PR's manifest anyway:

```
governance verify (registry manifest)
  canonical  DIFFERS from registry
  content    1 modified · 0 missing · 0 untracked

✘ local manifest does not match the registry at v1.0.0
✘ governed file modified: skills/error-handling/SKILL.md
```

**Add a rogue skill that grants exemptions.** Caught as untracked content:

```
✘ untracked file under .governance: skills/rogue-exemptions.md
```

**Delete a rule file.** Caught as missing content:

```
✘ governed file missing: policies/semgrep/security.yaml
```

**Delete the CI workflow.** CODEOWNERS covers `.github/**` and the ruleset
requires code-owner review.

**Get the agent to wave it through.** The agent's output is schema-validated, it
can only cite rule ids from the resolved policy (an invented id can never block),
findings on files it was not shown are discarded, and a review that could not
complete is forced to at least `warn` — it can never report `pass` for work it
did not see.

---

## Fixing drift

```bash
govctl restore
```

```
✔ restored skills/error-handling/SKILL.md
✔ re-bound governance.json to the v1.0.0 manifest
governance verify (local manifest)
  content    10 files verified
```

`restore` diffs against the **registry's** manifest, not the local one — so it
repairs the case where both the file and the manifest were rewritten, which is
exactly the state where a local diff would report everything is fine.

---

## Updating to a new governance release

```bash
govctl sync            # or: govctl sync --tag v1.2.0
govctl status
```

```
governance status
  registry   https://github.com/your-org/governance.git
  tier       corporate
  version    v1.0.0  (latest v1.3.0)
  staleness  3 release(s) behind, tier allows 2
  rules      10 blocking · 2 advisory · 0 off
  integrity  clean
```

Staleness is enforced, not just displayed: on the corporate tier, being more than
two releases behind fails `governance-integrity`. Startup allows six. A hotfix
that genuinely cannot wait can run `verify --remote --strict --skip-staleness`,
which skips *only* the freshness check — every integrity check still applies.

---

## The second project, on a different tier

```bash
govctl init --registry https://github.com/your-org/governance.git --tier startup
```

Same registry, same skills, same rules — different bite:

```
corporate:  10 blocking · 2 advisory · 0 off    staleness window: 2 releases
startup:     3 blocking · 9 advisory · 0 off    staleness window: 6 releases
```

No code changes anywhere. The tier YAML is the only thing that differs, and the
resolution is deterministic — `govctl`, the CI verifier and the agent all call the
same `resolvePolicy` function, so local advice and merge gating can never disagree.
