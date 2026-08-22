/**
 * Node identity, stored per *tab* rather than per browser.
 *
 * sessionStorage is the deliberate choice: two tabs of this app are two
 * different nodes, and they must not share an id or they would discard each
 * other's packets as their own echo. sessionStorage still survives a reload,
 * so a node keeps its identity across refreshes — it just doesn't leak across
 * tabs the way localStorage would.
 */

const STORAGE_KEY = 'meshnet.identity.v1';

export interface Identity {
  /** Long-form UUID, human-debuggable. */
  uuid: string;
  /** 32-bit form used on the wire. Never 0 — 0 is reserved for "broadcast". */
  id: number;
  /** Short label shown in the UI and mesh graph. */
  name: string;
}

/** FNV-1a. Deterministic across reloads, which `Math.random` ids would not be. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const SYLLABLES = ['ka', 'mi', 'ro', 'ta', 'ne', 'zu', 'li', 'ov', 'ar', 'en', 'sh', 'du'];

function nameFor(id: number): string {
  const a = SYLLABLES[id % SYLLABLES.length];
  const b = SYLLABLES[(id >>> 8) % SYLLABLES.length];
  return (a + b).replace(/^./, (c) => c.toUpperCase());
}

export function loadIdentity(): Identity {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as Identity;
    } catch {
      /* fall through and regenerate */
    }
  }
  const uuid = crypto.randomUUID();
  let id = hash32(uuid);
  if (id === 0) id = 1;
  const identity: Identity = { uuid, id, name: nameFor(id) };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  return identity;
}

let counter = Math.floor(Math.random() * 0xffff);

/** Monotonic-ish 32-bit message id. Collides only after 2^32 messages. */
export function nextMsgId(): number {
  counter = (counter + 1) >>> 0;
  return (Math.imul(counter, 0x9e3779b1) ^ (Date.now() & 0xffff)) >>> 0;
}
