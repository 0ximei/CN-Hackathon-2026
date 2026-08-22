import { hash32, type Identity } from '@core/lib/ids';

import type { LocalCatalog } from '../storage/store';

const KEY = 'identity.v1';

const SYLLABLES = ['ka', 'mi', 'ro', 'ta', 'ne', 'zu', 'li', 'ov', 'ar', 'en', 'sh', 'du'];

function nameFor(id: number): string {
  const a = SYLLABLES[id % SYLLABLES.length];
  const b = SYLLABLES[(id >>> 8) % SYLLABLES.length];
  return (a + b).replace(/^./, (c) => c.toUpperCase());
}

/**
 * A random 128-bit hex string.
 *
 * `crypto.randomUUID` is a browser API and Hermes does not provide it. This is
 * not cryptographic and does not need to be: it is seed material for a node id
 * that is generated once and then stored, so the only property that matters is
 * that two phones in the same room do not pick the same one.
 */
function randomHex(): string {
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, '0');
  }
  return out;
}

/**
 * Identity is per install, and persists.
 *
 * The web build deliberately keys this to `sessionStorage` so that two tabs are
 * two nodes. There are no tabs here — one install is one node — so it lives in
 * the same SQLite file as everything else and survives restarts. That
 * stability matters more on a radio than in a browser: the BLE layer's
 * dial/wait tie-break is decided by node id, so an id that changed on every
 * launch would reshuffle which side of every link dials.
 */
export async function loadIdentity(catalog: LocalCatalog): Promise<Identity> {
  const stored = await catalog.kvGet(KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Identity;
      if (parsed?.id) return parsed;
    } catch {
      /* fall through and regenerate */
    }
  }

  const uuid = randomHex();
  let id = hash32(uuid);
  if (id === 0) id = 1;
  const identity: Identity = { uuid, id, name: nameFor(id) };
  await catalog.kvSet(KEY, JSON.stringify(identity));
  return identity;
}

/** Lets a demo relabel a phone without wiping its storage. */
export async function renameNode(catalog: LocalCatalog, identity: Identity, name: string): Promise<Identity> {
  const next = { ...identity, name: name.slice(0, 24) || identity.name };
  await catalog.kvSet(KEY, JSON.stringify(next));
  return next;
}
