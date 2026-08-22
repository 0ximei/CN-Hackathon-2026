import { ed25519 } from '@noble/curves/ed25519.js';

import { hash32 } from '@core/lib/ids';

/**
 * The key material behind a node identity.
 *
 * A node id on this mesh used to be a hash of a random UUID, which made it a
 * *claim*: nothing stopped a second phone from announcing the same id and
 * collecting replies meant for the first. Deriving the id from an Ed25519
 * public key instead makes it self-certifying — the id is a fingerprint of the
 * key, so claiming an id and proving it are the same act, and the proof costs
 * one challenge/response exchange rather than a registry nobody could host
 * offline anyway.
 *
 * Ed25519 rather than ECDSA: deterministic signatures (no per-signature
 * randomness to get wrong on a device with a weak RNG), 32-byte keys and
 * 64-byte signatures, which matters when the packet has to cross a link with a
 * 517-byte MTU.
 */
export interface NodeKeys {
  /** 32 bytes. Travels in IDENT_RES; everything else refers to its hash. */
  publicKey: Uint8Array;
  /** 32-byte Ed25519 seed. Never leaves this device. */
  secretKey: Uint8Array;
}

export const SEED_BYTES = 32;

/**
 * Random bytes, from the platform CSPRNG when there is one.
 *
 * `expo-crypto` is a native module, so it is only present once the app has been
 * rebuilt after it was added to package.json. Rather than refuse to start on an
 * older binary, this falls back to a JS pool and says so — `secure` is returned
 * alongside the bytes so the UI can be honest about which one produced the key
 * instead of implying a guarantee that is not there.
 */
export function randomBytes(n: number): { bytes: Uint8Array; secure: boolean } {
  try {
    // Required lazily: importing at module scope makes a missing native module
    // a startup crash rather than a degraded mode.
    const Crypto = require('expo-crypto') as { getRandomBytes(n: number): Uint8Array };
    const bytes = Crypto.getRandomBytes(n);
    if (bytes?.length === n) return { bytes: Uint8Array.from(bytes), secure: true };
  } catch {
    /* fall through to the pool below */
  }
  return { bytes: weakRandomBytes(n), secure: false };
}

/**
 * Last-resort entropy: Math.random mixed with timing jitter.
 *
 * Hermes seeds Math.random from the clock, so this is emphatically not a
 * CSPRNG. It exists so a phone running a binary built before expo-crypto was
 * added still gets a working — if not defensible — identity, and it is always
 * reported as insecure.
 */
function weakRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let mix = (Date.now() ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < n; i++) {
    mix = (Math.imul(mix ^ (Math.random() * 0xffffffff) >>> 0, 0x85ebca6b) >>> 0) ^ (i * 0x27d4eb2d);
    out[i] = (mix >>> ((i % 4) * 8)) & 0xff;
  }
  return out;
}

/** Derives the public half from a stored seed. */
export function keysFromSeed(seed: Uint8Array): NodeKeys {
  // keygen() reuses the buffer it is handed, so the seed is copied first —
  // otherwise the stored secret and the returned one alias each other.
  const copy = Uint8Array.from(seed.subarray(0, SEED_BYTES));
  const pair = ed25519.keygen(copy);
  return { publicKey: Uint8Array.from(pair.publicKey), secretKey: Uint8Array.from(copy) };
}

export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return Uint8Array.from(ed25519.sign(message, secretKey));
}

/**
 * Signature check. Never throws — a malformed key or signature off the radio
 * is a failed verification, not a crash.
 */
export function verify(sig: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, message, publicKey);
  } catch {
    return false;
  }
}

/**
 * The node id a public key is entitled to.
 *
 * `hash32` is FNV-1a — fine for bucketing and wrong for anything adversarial,
 * because finding a second key that hashes to the same 32 bits is cheap. The
 * id is therefore a *routing* label, and the public key is the identity: two
 * nodes colliding on an id are still distinguishable by key, and the UI
 * compares fingerprints, never ids. Widening the id would mean changing the
 * packet header, which is a protocol break for a property the fingerprint
 * already provides.
 */
export function nodeIdFor(publicKey: Uint8Array): number {
  const id = hash32(toHex(publicKey));
  return id === 0 ? 1 : id;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.length % 2 ? `0${hex}` : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
