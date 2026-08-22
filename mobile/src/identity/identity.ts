import type { Identity } from '@core/lib/ids';

import { fingerprintOf, type Fingerprint } from './fingerprint';
import {
  SEED_BYTES,
  fromHex,
  keysFromSeed,
  nodeIdFor,
  randomBytes,
  sign,
  toHex,
  type NodeKeys,
} from './keys';

/** Where the identity lives. v1 was a bare `{uuid, id, name}` with no key. */
const KEY_V1 = 'identity.v1';
const KEY_V2 = 'identity.v2';

/** The narrow slice of the catalog this module needs, so it can be tested flat. */
export interface IdentityStore {
  kvGet(key: string): Promise<string | null>;
  kvSet(key: string, value: string): Promise<void>;
}

export interface LocalIdentity extends Identity {
  /** Hex Ed25519 public key. The node id is derived from it. */
  publicKeyHex: string;
  createdAt: number;
  /**
   * Whether the seed came from the platform CSPRNG.
   *
   * Surfaced rather than swallowed: an identity generated from the JS fallback
   * pool is fine for a demo and worthless as a credential, and the difference
   * should be visible to whoever is relying on it.
   */
  secureRandom: boolean;
}

interface StoredIdentity extends LocalIdentity {
  /**
   * The Ed25519 seed, hex.
   *
   * In the app's own SQLite file, which on Android is inside private app
   * storage — readable by this app, by root, and by anyone with an unlocked
   * device and a debug build. The Android Keystore is where this belongs and
   * would keep the key off the JS heap entirely; it is not used here because
   * the signing happens in JS, and shipping the key to Kotlin to sign there is
   * a native surface this build does not have. Treat the identity as a demo
   * credential, not a durable one.
   */
  secretKeyHex: string;
}

export interface IdentitySession {
  identity: LocalIdentity;
  keys: NodeKeys;
  fingerprint: Fingerprint;
  /** Signs the exact bytes given. Nothing else in the app touches the seed. */
  sign(message: Uint8Array): Uint8Array;
}

const SYLLABLES = ['ka', 'mi', 'ro', 'ta', 'ne', 'zu', 'li', 'ov', 'ar', 'en', 'sh', 'du'];

/** A pronounceable default so the name field is never empty on first launch. */
export function suggestName(): string {
  const { bytes } = randomBytes(2);
  const a = SYLLABLES[bytes[0] % SYLLABLES.length];
  const b = SYLLABLES[bytes[1] % SYLLABLES.length];
  return (a + b).replace(/^./, (c) => c.toUpperCase());
}

/**
 * The name a first-launch screen should start from.
 *
 * A v1 install already had a name the operator may have been using on stage;
 * carrying it across is friendlier than handing them a new random one, even
 * though the id underneath is necessarily changing.
 */
export async function priorName(store: IdentityStore): Promise<string | null> {
  const raw = await store.kvGet(KEY_V1);
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as Identity).name ?? null;
  } catch {
    return null;
  }
}

/**
 * Loads the identity this device already created, or null on a fresh install.
 *
 * Null is a normal outcome, not an error: it is what puts the app into its
 * identity-creation screen. Nothing else in the app runs before this resolves,
 * because the node id decides the database namespace, the BLE dial/wait
 * tie-break and every holder record written.
 */
export async function loadIdentity(store: IdentityStore): Promise<IdentitySession | null> {
  const raw = await store.kvGet(KEY_V2);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as StoredIdentity;
    if (!stored?.secretKeyHex || !stored.publicKeyHex) return null;
    const keys = keysFromSeed(fromHex(stored.secretKeyHex));

    // The stored public key and id are re-derived rather than trusted. A file
    // edited by hand, or half-written by a crash mid-upgrade, would otherwise
    // let this node sign with one key while announcing another — which every
    // peer would correctly read as an impersonation attempt.
    const publicKeyHex = toHex(keys.publicKey);
    const id = nodeIdFor(keys.publicKey);
    const identity: LocalIdentity = {
      uuid: stored.uuid,
      id,
      name: stored.name,
      publicKeyHex,
      createdAt: stored.createdAt,
      secureRandom: stored.secureRandom !== false,
    };
    if (publicKeyHex !== stored.publicKeyHex || id !== stored.id) {
      await store.kvSet(
        KEY_V2,
        JSON.stringify({ ...stored, ...identity, secretKeyHex: stored.secretKeyHex }),
      );
    }
    return session(identity, keys);
  } catch {
    return null;
  }
}

/**
 * Creates this device's identity: a keypair, and a name the user chose.
 *
 * Called once, from the first-launch screen. The node id falls out of the key
 * rather than being generated alongside it, so there is no step at which the
 * device holds an id it cannot prove.
 */
export async function createIdentity(
  store: IdentityStore,
  name: string,
): Promise<IdentitySession> {
  const { bytes: seed, secure } = randomBytes(SEED_BYTES);
  const keys = keysFromSeed(seed);
  const publicKeyHex = toHex(keys.publicKey);

  const identity: LocalIdentity = {
    uuid: publicKeyHex.slice(0, 32),
    id: nodeIdFor(keys.publicKey),
    name: cleanName(name) || suggestName(),
    publicKeyHex,
    createdAt: Date.now(),
    secureRandom: secure,
  };

  await store.kvSet(
    KEY_V2,
    JSON.stringify({ ...identity, secretKeyHex: toHex(keys.secretKey) } satisfies StoredIdentity),
  );
  return session(identity, keys);
}

/**
 * Changes the display name, keeping the key and therefore the id.
 *
 * Worth being explicit that this is not a new identity: peers that verified
 * this node keep their verification, because what they verified was the key.
 * The name is signed inside IDENT_RES, so a renamed node re-proves the new name
 * on the next challenge rather than silently disagreeing with what peers cached.
 */
export async function renameIdentity(
  store: IdentityStore,
  current: IdentitySession,
  name: string,
): Promise<IdentitySession> {
  const next = cleanName(name);
  if (!next || next === current.identity.name) return current;
  const raw = await store.kvGet(KEY_V2);
  const stored = raw ? (JSON.parse(raw) as StoredIdentity) : null;
  if (!stored) return current;
  const identity = { ...current.identity, name: next };
  await store.kvSet(KEY_V2, JSON.stringify({ ...stored, ...identity }));
  return session(identity, current.keys);
}

/** Names are shown next to results from a stranger's phone — keep them plain. */
export function cleanName(raw: string): string {
  // Control characters and the separators the wire format and the UI both use
  // as delimiters, stripped so a name cannot forge structure in either.
  return raw
    .split('')
    .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, 24);
}

function session(identity: LocalIdentity, keys: NodeKeys): IdentitySession {
  return {
    identity,
    keys,
    fingerprint: fingerprintOf(keys.publicKey),
    sign: (message) => sign(message, keys.secretKey),
  };
}
