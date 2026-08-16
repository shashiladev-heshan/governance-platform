# Testing this on a real project

Two stages. Stage 1 takes about five minutes and needs nothing but this checkout.
Stage 2 puts it on GitHub with real PRs and real blocked merges.

The private npm registry does **not** need to exist yet — both stages install the
tooling from source.

---

## Stage 1 — local rehearsal (5 minutes)

```bash
bash scripts/pilot-local.sh
```

This creates two real git repos under `./pilot/`:

- `pilot/registry` — a governance registry with a signed `v1.0.0` release
- `pilot/demo-service` — a new project attached to it, with real git hooks

and then walks the whole flow: attaching the project, a pre-commit hook rejecting
an edit to a governed skill, `govctl restore` repairing it, a feature branch with
four real violations, the CI integrity check, semgrep, and the semantic review
with its PR comment and gate exit code — corporate tier blocking, startup tier
advisory on the same findings.

Prerequisites: Node 20+, git. Optional: `pipx install semgrep` (the pattern job is
skipped with a note if it is missing), and `ANTHROPIC_API_KEY` to run the real
agent instead of the mock.

Both repos are left on disk. Poke at them — this is the fastest way to build a
feel for what developers will experience.

### Doing it by hand instead

If you would rather drive it yourself on **your own** repo:

```bash
# 1. install the CLIs (until private npm exists)
bash scripts/install-local.sh            # writes shims into ~/.local/bin

# 2. stand up a registry from the template
cp -R registry-template ~/dev/governance
cd ~/dev/governance
govctl keygen --key-id platform-signer --out ~/.govctl/signing-key.json --trust
govctl manifest generate --dir . --tag v1.0.0
govctl sign --dir . --key ~/.govctl/signing-key.json
git init -b main && git add -A && git commit -m "governance v1.0.0"
git tag -a v1.0.0 -m v1.0.0

# 3. attach your project
cd ~/dev/your-service
govctl init --registry ~/dev/governance --tier corporate
npx lefthook install

# 4. see it work
govctl status
echo "# tampered" >> .governance/skills/error-handling/SKILL.md
git commit -am "test"          # rejected by the pre-commit hook
govctl restore
```

---

## Stage 2 — real PRs on GitHub

### 2.1 Push the registry

```bash
cd ~/dev/governance                       # or pilot/registry
gh repo create your-org/governance --private --source=. --push
git push origin v1.0.0                    # the tag matters — govctl resolves tags
```

Add these to the governance repo (Settings → Secrets and variables → Actions):

| Kind | Name | Value |
|---|---|---|
| Secret | `GOVERNANCE_SIGNING_KEY` | contents of `signing-key.json` |

`.github/workflows/release.yml` is already in the template. Cutting a release is
**Actions → release → Run workflow → v1.1.0** — it validates, generates the
manifest, signs, commits, tags and publishes. Do not tag by hand: `govctl` reads
the manifest from the tagged tree, so the manifest has to be in that commit.

### 2.2 Publish the trust root

Developers and CI need the public half of the signing key.

```bash
cat ~/.govctl/trust.json
```

Set that JSON as an **organisation** variable named `GOVERNANCE_TRUST_ROOT`
(Settings → Secrets and variables → Actions → Variables → New organization
variable). Org level, not repo level — a repo that can edit its own trust root can
vouch for its own governance content.

For developer machines, distribute the same file to `~/.govctl/trust.json` (MDM,
onboarding script, or `govctl trust add --key <public-key-file>`).

### 2.3 Attach a pilot project

```bash
cd ~/dev/your-service
govctl init --registry https://github.com/your-org/governance.git --tier corporate
npx lefthook install
cp <this-repo>/project-integration/.github/workflows/governance-verify.pilot.yml .github/workflows/
cp <this-repo>/project-integration/CODEOWNERS .github/CODEOWNERS
$EDITOR .github/CODEOWNERS      # replace @your-org/platform-team
git add -A && git commit -m "chore: attach governance"
git push
```

Use `governance-verify.pilot.yml` for now — it builds `govctl` from a checkout of
the governance repo. Swap to `governance-verify.yml` once the packages are
published to private npm; the checks are otherwise identical.

Repository configuration for the pilot workflow:

| Kind | Name | Value |
|---|---|---|
| Variable | `GOVERNANCE_REPO` | `your-org/governance` |
| Variable | `GOVERNANCE_TOOLING_REF` | `main` (or a tag, to pin the tooling) |
| Variable | `GOVERNANCE_TRUST_ROOT` | inherited from the org variable |
| Secret | `GOVERNANCE_REPO_TOKEN` | PAT or app token with read access to the governance repo |
| Secret | `ANTHROPIC_API_KEY` | optional — without it the validator runs in mock mode |

`GOVERNANCE_REPO_TOKEN` is needed twice: to check out the governance repo for the
build, and to let `govctl verify --remote` clone the registry. The workflow wires
the second one up with a `git config url.insteadOf` rewrite, so no token ever
lands in `governance.json`.

### 2.4 Open a PR that should fail

```bash
git checkout -b feat/checkout
# add a controller with @Body() body: any, a process.env read,
# an interpolated SQL string and a log-and-continue catch block
git push -u origin feat/checkout
gh pr create --fill
```

Expect: `governance-integrity` green, `governance-patterns` red with four semgrep
findings, `governance-semantic` red (or advisory on the startup tier) with a
review comment on the PR.

Then try the tamper paths on a PR — edit a governed skill, regenerate the
manifest, re-sign it with your own key. All three fail `governance-integrity`.

### 2.5 Make it binding

Nothing above blocks a merge until the ruleset exists. Follow
[RULESET-SETUP.md](RULESET-SETUP.md) and add these as required checks:

```
governance-integrity
governance-patterns
governance-semantic
```

(The pilot workflow has no `governance-lint` job — it assumes your project's own
lint setup. Add it when you adopt `@shashiladev-heshan/eslint-config`.)

Confirm with the checklist at the end of RULESET-SETUP.md: five actions, all of
which must fail.

---

## Recommended sequence

1. **Day 1** — `scripts/pilot-local.sh`, then repeat it by hand on a scratch repo
2. **Day 2** — push the registry, set the trust root, attach one internal repo,
   run PRs **without** a ruleset and watch the checks
3. **Week 1** — apply the ruleset to that one repo; run the validator warn-only by
   putting the semantic rules at `warn` in a `tiers/pilot.yaml`
4. **Week 2–3** — triage every agent finding for false positives (see
   [AGENT.md](AGENT.md#calibration--before-turning-blocking-on)); fix the *skills*,
   not the prompt
5. **Then** — promote rules to `block` one at a time, and roll out to more repos

## What to fix before rolling out widely

- **Publish the packages.** `npm i -g @shashiladev-heshan/govctl` is the intended install; the
  from-source build is a pilot bridge. See [PUBLISHING.md](PUBLISHING.md) — and
  rename the `@shashiladev-heshan/` scope to your org's name *before* the first publish, because
  GitHub Packages requires the scope to match the org.
- **Move to cosign keyless.** The dev signer means a long-lived private key in a
  repo secret. See [SIGNING.md](SIGNING.md).
- **Rename the `@shashiladev-heshan/` scope** to `@allion/` before the first publish, not after.
- **Replace `@your-org/platform-team`** in CODEOWNERS with the real team.
- **Write skills from your own codebases.** The four in `registry-template/skills/`
  are worked examples with real good/bad pairs, but they are not your conventions
  until someone senior has read them line by line.
