import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { sha256Bytes, canonicalJsonBytes } from './hash.js';
import type { TrustStore } from './trust.js';

/**
 * Signature bundle written next to the manifest in the registry release.
 *
 * `publicKey` is carried for diagnostics only — verification looks the key up in
 * the trust store by `keyId` and requires an exact match. A bundle that ships its
 * own key is worthless to an attacker: swapping in a self-generated keypair fails
 * at the trust-store lookup, not at the signature check.
 */
export interface SignatureBundle {
  schemaVersion: 1;
  alg: 'ed25519';
  keyId: string;
  signer: string;
  publicKey: string;
  signature: string;
  subject: { algorithm: 'sha256'; digest: string };
}

export interface VerifyResult {
  ok: boolean;
  keyId?: string;
  signer?: string;
  reason?: string;
}

export interface DevKeypair {
  keyId: string;
  publicKey: string;
  privateKey: string;
}

/**
 * Dev signer: ed25519 keypair on disk. Stands in for cosign keyless until the
 * registry's GitHub Actions release pipeline exists, so the full trust chain is
 * testable offline today. See "The signing model" in the README for the migration.
 */
export function generateKeypair(keyId: string): DevKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    keyId,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

export function signBytes(
  bytes: Buffer,
  keypair: DevKeypair,
  signer = 'dev-ed25519',
): SignatureBundle {
  const privateKey = createPrivateKey({
    key: Buffer.from(keypair.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });

  return {
    schemaVersion: 1,
    alg: 'ed25519',
    keyId: keypair.keyId,
    signer,
    publicKey: keypair.publicKey,
    signature: cryptoSign(null, bytes, privateKey).toString('base64'),
    subject: { algorithm: 'sha256', digest: sha256Bytes(bytes) },
  };
}

export function serializeBundle(bundle: SignatureBundle): Buffer {
  return canonicalJsonBytes(bundle);
}

export function parseBundle(bytes: Buffer | string): SignatureBundle {
  const parsed = JSON.parse(bytes.toString('utf8')) as SignatureBundle;
  if (parsed?.schemaVersion !== 1) {
    throw new Error(`unsupported bundle schemaVersion: ${String(parsed?.schemaVersion)}`);
  }
  if (parsed.alg !== 'ed25519') {
    throw new Error(`unsupported signature algorithm: ${String(parsed.alg)}`);
  }
  return parsed;
}

/**
 * Verify a signature bundle over the exact manifest bytes.
 *
 * Order matters — each step is a distinct tamper path:
 *   1. digest binding    — bundle must describe THESE bytes
 *   2. trust lookup      — keyId must be a key we trust out-of-band
 *   3. key binding       — the bundle's key must equal the trusted key
 *   4. signature         — cryptographic check
 */
export function verifyBundle(
  bytes: Buffer,
  bundle: SignatureBundle,
  trust: TrustStore,
): VerifyResult {
  const digest = sha256Bytes(bytes);
  if (bundle.subject?.digest !== digest) {
    return {
      ok: false,
      keyId: bundle.keyId,
      reason: `signature covers a different manifest (bundle says ${short(bundle.subject?.digest)}, actual ${short(digest)})`,
    };
  }

  const trusted = trust.keys.find((k) => k.keyId === bundle.keyId);
  if (!trusted) {
    return {
      ok: false,
      keyId: bundle.keyId,
      reason: `key '${bundle.keyId}' is not in the trust store (${trust.source})`,
    };
  }
  if (trusted.status === 'revoked') {
    return { ok: false, keyId: bundle.keyId, reason: `key '${bundle.keyId}' is revoked` };
  }
  if (trusted.publicKey !== bundle.publicKey) {
    return {
      ok: false,
      keyId: bundle.keyId,
      reason: `public key for '${bundle.keyId}' does not match the trust store — manifest was re-signed with a foreign key`,
    };
  }

  let valid = false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(trusted.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    valid = cryptoVerify(null, bytes, publicKey, Buffer.from(bundle.signature, 'base64'));
  } catch (err) {
    return { ok: false, keyId: bundle.keyId, reason: `signature check failed: ${(err as Error).message}` };
  }

  if (!valid) {
    return { ok: false, keyId: bundle.keyId, reason: 'signature does not verify' };
  }

  return { ok: true, keyId: bundle.keyId, signer: bundle.signer };
}

/**
 * Placeholder for the production path. The registry release workflow will produce
 * a cosign bundle via GitHub OIDC (no long-lived key); this is where govctl will
 * verify the certificate identity (issuer + subject repo/workflow) before the
 * signature. Until then, `signer: 'cosign-keyless'` bundles are rejected outright
 * rather than trusted-by-default.
 */
export function verifyCosignBundle(): VerifyResult {
  return {
    ok: false,
    reason:
      'cosign keyless verification is not implemented yet — see "The signing model" in the README. ' +
      'Refusing to trust a cosign bundle rather than skipping the check.',
  };
}

function short(hex: string | undefined): string {
  return hex ? hex.slice(0, 12) : '<none>';
}
