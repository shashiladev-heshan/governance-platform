# Publishing the tooling

## Repo topology, first

Two repositories, and the distinction matters:

| Repo | What it is | What it produces |
|---|---|---|
| `shashiladev-heshan/governance-platform` | **This** monorepo — the tooling | npm packages: `@shashiladev-heshan/policy-core`, `@shashiladev-heshan/govctl`, `@shashiladev-heshan/governance-validator` |
| `shashiladev-heshan/governance` | The **registry**, created from `registry-template/` | signed releases: skills, policies, tiers + `@shashiladev-heshan/eslint-config`, `@shashiladev-heshan/prettier-config`, `@shashiladev-heshan/tsconfig` |

They release on different clocks. The registry ships governance *content* every
week or two; the tooling ships when the verifier itself changes, which should be
rare. Keeping them apart means a routine rule change cannot accidentally alter the
code that enforces rules.

## Do you have to publish?

For a pilot, no — `governance-verify.pilot.yml` builds the tooling from a checkout.
For rollout, yes, for three reasons:

1. **Speed.** Building from source adds `npm ci` + `tsc` to every governance job on
   every PR across every repo.
2. **Pinning.** A branch ref is a moving target. `@shashiladev-heshan/govctl@1.4.2` is not.
3. **Trust.** The verifier should be an artifact you published deliberately, not
   whatever happened to be on a branch when CI ran.

## Where to publish

**GitHub Packages** (`https://npm.pkg.github.com`) is the least-effort option on
GitHub Cloud: no extra vendor, access follows repo permissions, and `GITHUB_TOKEN`
publishes without managing a secret.

One hard constraint: **the package scope must equal the GitHub owner name.** The
same applies to npmjs private orgs — scope must match the npm org.

The scope here is `@shashiladev-heshan/`, matching the account running the pilot.
Settle the scope before the first publish, not after: renaming later means every
consumer repo edits its workflows and lockfiles. To move it to an Allion org:

```bash
# from the repo root
grep -rl '@shashiladev-heshan/' --include='*.json' --include='*.ts' --include='*.js' \
  --include='*.mjs' --include='*.yml' --include='*.md' --include='*.sh' . \
  | grep -v node_modules | grep -v /dist/ | grep -v '^./pilot/' \
  | xargs sed -i '' 's|@shashiladev-heshan/|@allion/|g'
rm -rf node_modules package-lock.json && npm install && npm test
```

That sed also rewrites prose in this file and the README that *talks about* the
scope, so re-read both afterwards.

Alternatives: a private npmjs org (works well behind corporate proxies, costs
money per seat), Verdaccio self-hosted (free, one more thing to run), Artifactory
(if the org already has it).

## Publishing

```bash
bash scripts/publish.sh              # dry run — packs everything, publishes nothing
bash scripts/publish.sh --yes        # for real
```

Or **Actions → publish → Run workflow**, which does the same with version bumping,
an immutability check, and a `tooling-vX.Y.Z` tag.

The script builds, runs the full test suite, refuses to continue if any package
has no `dist/`, and publishes in dependency order: `policy-core` first, because
npm resolves that dependency from the registry, not from the workspace.

### Version bumps

```bash
npm version 0.2.0 --no-git-tag-version --workspaces
node scripts/sync-internal-deps.mjs 0.2.0
npm install --package-lock-only
```

The second line is not optional. `npm version --workspaces` bumps each package's
own version and leaves dependency *ranges* untouched, so without it `govctl@0.2.0`
still depends on `policy-core@^0.1.0` — a fresh install then pairs new gating code
with an old policy resolver, and the two disagree about what a tier means. That
failure is silent and only shows up as inconsistent merge decisions.

## Consuming

```bash
# ~/.npmrc  — the USER config, not a repo-level .npmrc
@shashiladev-heshan:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<a token with read:packages>
```

**It has to be the user config.** `npm install -g` ignores a project-level
`.npmrc` — there is no project — so a repo-level file gets you:

```
npm error 404 Not Found - GET https://registry.npmjs.org/@scope%2fgovctl
```

which reads like "the package was never published" and sends people looking in
entirely the wrong place. Either put it in `~/.npmrc`, or point npm at a specific
file: `NPM_CONFIG_USERCONFIG=/path/to/.npmrc npm i -g @scope/govctl`.

In Actions this is handled for you — `actions/setup-node` with `registry-url` and
`scope` writes an npmrc and sets `NPM_CONFIG_USERCONFIG` to it.

Then the workflows work as written:

```yaml
- name: Install govctl
  run: npm install -g @shashiladev-heshan/govctl@${{ vars.GOVCTL_VERSION }}
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_READ_TOKEN }}
```

Pin `GOVCTL_VERSION` to an exact version as an **organisation** variable. Then
upgrading the verifier across every governed repo is one variable change, and
rolling back is the same.

## Shipping a populated trust root

`packages/govctl/trust/trust.json` is the last-resort trust root, shipped empty on
purpose — an empty store fails closed with a clear message rather than trusting
anything. If you would rather every install arrive knowing the org's signing key,
have the publish pipeline write it before packing:

```yaml
- name: Bake the trust root into govctl
  run: printf '%s' "$TRUST_ROOT" > packages/govctl/trust/trust.json
  env:
    TRUST_ROOT: ${{ vars.GOVERNANCE_TRUST_ROOT }}
```

Trade-off: it makes onboarding a one-liner, but rotating a key then needs a
package release as well as a variable change. Both are defensible; pick one and
write it down. CI should keep setting `GOVCTL_TRUST_ROOT` explicitly either way —
CI's trust must not depend on which version of a package happened to be installed.

## Verifying the packaging

The packaging in this repo was checked against a real registry (Verdaccio on
localhost), not just `npm pack`:

```bash
npx verdaccio@6 --listen 4873 &
npm adduser --registry http://localhost:4873          # any credentials
bash scripts/publish.sh --yes --registry http://localhost:4873
npm i -g --prefix /tmp/gtest --registry http://localhost:4873 @shashiladev-heshan/govctl
/tmp/gtest/bin/govctl --version
cd <a governed project> && /tmp/gtest/bin/govctl verify --remote --strict
```

Worth repeating after any change to `files`, `exports`, or the dependency ranges.
A package that installs but cannot resolve `@shashiladev-heshan/policy-core` still exits 0 on
`npm i` and only fails when someone runs it — which, for a verifier, means it
fails in CI on somebody else's PR.

## Config packages

`@shashiladev-heshan/eslint-config`, `@shashiladev-heshan/prettier-config` and `@shashiladev-heshan/tsconfig` live in
`registry-template/configs/` and are published by the **registry's** release
workflow, not this one. They are versioned with the governance content because
that is what they are: the mechanical half of the policy.
