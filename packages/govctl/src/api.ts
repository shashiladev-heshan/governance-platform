/**
 * Programmatic surface. The CI verifier and the validator agent import from here
 * so there is exactly one implementation of "is this project's governance intact".
 */
export * from './verify.js';
export * from './lib/manifest.js';
export * from './lib/signing.js';
export * from './lib/trust.js';
export * from './lib/config.js';
export * from './lib/registry.js';
export * from './lib/hash.js';
