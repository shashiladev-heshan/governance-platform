import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Streaming SHA-256 of a file's raw bytes. Hex, lowercase. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function sha256Bytes(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Canonical JSON: recursively sorted object keys, 2-space indent, trailing
 * newline. The manifest is signed over these exact bytes, so serialization must
 * be byte-stable across machines and Node versions.
 */
export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(sortKeys(value), null, 2) + '\n', 'utf8');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
