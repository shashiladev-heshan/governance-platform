# Signing model

## What is signed, and over what bytes

The signature covers the **exact bytes of `manifest.lock.json`**, not a
re-serialisation of its contents. `canonicalJsonBytes` writes the manifest with
recursively sorted keys, two-space indent and a trailing newline, so the file is
byte-stable across machines and Node versions — which is what makes signing the
file itself safe.

The bundle records the digest of those bytes as `subject.digest`, so verification
can reject a bundle that describes a *different* manifest before doing any
cryptography.

## Why the bundle's own public key is not trusted

`manifest.lock.json.bundle` carries `publicKey`, but verification never uses it as
the source of trust. The order is:

1. **Digest binding** — `sha256(manifest bytes)` must equal `subject.digest`
2. **Trust lookup** — `keyId` must exist in the trust store, and not be revoked
3. **Key binding** — the trust store's key for that id must equal the bundle's key
4. **Signature** — verified against the *trust store's* key

Step 3 is the important one. Without it, an attacker re-signs with a self-generated
keypair, ships the matching public key in the bundle, and everything verifies. With
it, the attack fails at "key id not in the trust store" — which is what
`packages/govctl/test/tamper.test.js` path 3 asserts.

## Where the trust root comes from

Resolution order, in `packages/govctl/src/lib/trust.ts`:

1. `$GOVCTL_TRUST_ROOT` — CI writes this from an org-level variable
2. `~/.govctl/trust.json` — developer machines, seeded at onboarding or by MDM
3. `<govctl package>/trust/trust.json` — shipped with the CLI from private npm

Deliberately **not** read from the repository being verified. A repo must never be
able to nominate the key that vouches for its own governance content.

## Current state: local dev signer

`govctl keygen` produces an ed25519 keypair; `govctl sign` produces the bundle.
This exists so the entire trust chain is testable offline, today, before any
GitHub infrastructure is stood up.

```bash
govctl keygen --key-id platform-signer --out signing-key.json --trust
govctl manifest generate --dir . --tag v1.0.0
govctl sign --dir . --key signing-key.json
```

In the release workflow the private key lives in `secrets.GOVERNANCE_SIGNING_KEY`.
This is the part with a real operational cost: a long-lived key that can be leaked
and must be rotated.

## Target state: cosign keyless

The release workflow already requests `id-token: write`. The migration:

1. Replace the signing step:

   ```yaml
   - run: cosign sign-blob --yes --bundle manifest.lock.json.bundle manifest.lock.json
   ```

2. Implement `verifyCosignBundle` in `packages/govctl/src/lib/signing.ts`. It must
   check the **certificate identity** before the signature:

   - issuer is `https://token.actions.githubusercontent.com`
   - subject matches `https://github.com/your-org/governance/.github/workflows/release.yml@refs/heads/main`

   Verifying the signature without pinning the identity is close to worthless —
   any GitHub Actions workflow anywhere can produce a valid keyless signature.

3. Replace the trust store's key list with the expected identity constraints.

Until that is done, `verifyProject` **rejects** any bundle whose `signer` is
`cosign-keyless` rather than trusting it. A half-finished migration fails closed,
loudly, instead of silently skipping the check.

## Key rotation (while the dev signer is in use)

1. `govctl keygen --key-id platform-signer-2 --out new-key.json`
2. Add the new public key to the trust root, alongside the old one, and roll it out
   (CI variable, MDM, next `govctl` release)
3. Cut a release signed with the new key
4. Once every consumer has the new trust root, mark the old key
   `"status": "revoked"` — verification then rejects anything still signed with it

Revocation is a status flag rather than a deletion so that "this was signed by a
key we have since revoked" produces a clear message instead of "unknown key".

## Compromise response

A leaked signing key means an attacker can produce manifests that verify. Steps:

1. Mark the key revoked in the trust root and push it everywhere
2. Re-sign every supported release with a new key
3. Audit registry tags for commits not produced by the release workflow
4. Move the migration to cosign keyless forward — a compromised long-lived key is
   the failure mode keyless signing exists to eliminate
