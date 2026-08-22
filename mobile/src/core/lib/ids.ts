/**
 * Node identity on the wire.
 *
 * The browser build mints an identity with `crypto.randomUUID` and keeps it in
 * `sessionStorage`, neither of which exists in React Native — and neither of
 * which this build wants. A phone's identity is a keypair, its node id is the
 * hash of the public key, and both live in SQLite; see `src/identity/`. What is
 * genuinely shared is the wire-level shape and the two functions below, so only
 * those are here.
 */

export interface Identity {
    /** Long-form UUID, human-debuggable. */
    uuid: string;
    /** 32-bit form used on the wire. Never 0 — 0 is reserved for "broadcast". */
    id: number;
    /** Short label shown in the UI and mesh graph. */
    name: string;
}

/** FNV-1a. Deterministic across restarts, which `Math.random` ids would not be. */
export function hash32(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

let counter = Math.floor(Math.random() * 0xffff);

/** Monotonic-ish 32-bit message id. Collides only after 2^32 messages. */
export function nextMsgId(): number {
    counter = (counter + 1) >>> 0;
    return (Math.imul(counter, 0x9e3779b1) ^ (Date.now() & 0xffff)) >>> 0;
}
