import { sha256 } from '@noble/hashes/sha2.js';

import { toHex } from './keys';

/**
 * Human-checkable renderings of a public key.
 *
 * A cryptographic check proves a peer holds the key behind the id it is using.
 * It cannot prove that key belongs to the person standing in front of you —
 * nothing on the radio can, because an attacker in the room generates a
 * perfectly valid key of their own. Closing that gap needs a channel the radio
 * does not control: two people looking at their screens and comparing. So the
 * key has to be rendered in a form a human can actually compare under a time
 * limit, which a raw key in hex is not.
 */

/**
 * Icon alphabet for the at-a-glance check.
 *
 * 32 entries, so each icon carries exactly 5 bits and the mapping is a plain
 * bit-slice with no modulo bias. Chosen for distinct *silhouettes* rather than
 * distinct subjects: the comparison happens at arm's length in bad light, where
 * interior detail is the first thing to go and only the outline survives.
 *
 * These are Ionicons glyph names, deliberately the filled variants for the same
 * reason. Emoji are the obvious pick here and are the wrong one — the same
 * codepoint is drawn differently by every vendor, so two phones comparing a
 * fingerprint can legitimately disagree about what they are showing, which is
 * precisely the failure this check exists to rule out. A bundled vector font
 * renders identically on every device.
 *
 * A typo here is caught by `tsc`, not by a blank square on someone's phone:
 * `FingerprintIcon` flows into the `name` prop of `Ionicons`, whose type is
 * generated from the real glyph map.
 */
const ICONS = [
  'rocket', 'flame', 'leaf', 'key',
  'moon', 'flash', 'fish', 'cube',
  'star', 'planet', 'snow', 'umbrella',
  'bulb', 'magnet', 'heart', 'skull',
  'paw', 'bug', 'boat', 'airplane',
  'bicycle', 'train', 'basketball', 'diamond',
  'hammer', 'wine', 'pizza', 'flag',
  'balloon', 'gift', 'trophy', 'shield',
] as const;

/** One of the 32. Assignable to `Ionicons`' `name`, which is what checks it. */
export type FingerprintIcon = (typeof ICONS)[number];

export interface Fingerprint {
  /** Four groups of four hex digits — precise, for a careful comparison. */
  hex: string;
  /** Five icons — imprecise, for a two-second one. */
  icons: FingerprintIcon[];
}

/**
 * One node's own fingerprint, shown on its identity card.
 *
 * Hashed rather than shown raw so the displayed value stays the same length
 * whatever the key format, and so a truncation is a truncation of a hash rather
 * than of a key — the first bytes of an Ed25519 key are not more significant
 * than the last, and showing a prefix would invite the assumption that they are.
 */
export function fingerprintOf(publicKey: Uint8Array): Fingerprint {
  const digest = sha256(publicKey);
  const hex = toHex(digest.subarray(0, 8));
  return {
    hex: (hex.match(/.{4}/g) ?? []).join(' ').toUpperCase(),
    icons: iconsFrom(digest, 5),
  };
}

/**
 * The number both phones show when two nodes verify each other.
 *
 * Derived from *both* keys, sorted, so each side computes the same value
 * without agreeing who goes first — and so a value read off one screen is
 * meaningless anywhere else. Thirty digits in six groups: long enough that
 * grinding a collision is not a party trick, short enough to read aloud.
 */
export function safetyNumber(a: Uint8Array, b: Uint8Array): string {
  const [lo, hi] = compare(a, b) <= 0 ? [a, b] : [b, a];
  const joined = new Uint8Array(lo.length + hi.length);
  joined.set(lo);
  joined.set(hi, lo.length);
  const digest = sha256(joined);

  // Five digits per group, each from its own 20-bit slice of the digest, so no
  // two groups share entropy and a transposition is always visible.
  const groups: string[] = [];
  for (let g = 0; g < 6; g++) {
    const o = g * 3;
    const v = ((digest[o] << 16) | (digest[o + 1] << 8) | digest[o + 2]) % 100000;
    groups.push(String(v).padStart(5, '0'));
  }
  return groups.join(' ');
}

/** The same pair rendered as icons, for people who compare pictures faster. */
export function safetyIcons(a: Uint8Array, b: Uint8Array): FingerprintIcon[] {
  const [lo, hi] = compare(a, b) <= 0 ? [a, b] : [b, a];
  const joined = new Uint8Array(lo.length + hi.length);
  joined.set(lo);
  joined.set(hi, lo.length);
  return iconsFrom(sha256(joined), 6);
}

function iconsFrom(digest: Uint8Array, count: number): FingerprintIcon[] {
  const out: FingerprintIcon[] = [];
  for (let i = 0; i < count; i++) out.push(ICONS[digest[i] & 0x1f]);
  return out;
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
