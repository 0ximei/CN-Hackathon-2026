import { identChallengeBytes, type IdentResPayload } from '@core/protocol/packet';

import { fromHex, nodeIdFor, toHex, verify } from './keys';

/**
 * How much this node believes a peer is who it says it is.
 *
 * Four of these are conclusions the radio can reach on its own; `trusted` is
 * the only one that requires a person, and it is deliberately separate from
 * `verified` rather than an upgrade the software can award itself.
 */
export type TrustState =
  /** Seen beaconing, never challenged — or challenged and still waiting. */
  | 'unknown'
  /** A challenge is outstanding. */
  | 'pending'
  /** Signature good, and the node id really is this key's hash. */
  | 'verified'
  /** Verified, and a human compared the safety number out of band. */
  | 'trusted'
  /** The key behind this id changed since it was last verified. */
  | 'mismatch'
  /** Signature bad, or the id does not belong to the key that signed. */
  | 'failed';

export interface PeerIdentity {
  nodeId: number;
  /** Hex Ed25519 public key, or '' before the first IDENT_RES arrives. */
  publicKeyHex: string;
  /** The name the peer signed. May differ from the one in its beacon. */
  name: string;
  firstSeen: number;
  /** Last time a signature checked out. 0 when never. */
  verifiedAt: number;
  /** When a person confirmed the safety number. 0 when never. */
  trustedAt: number;
  state: TrustState;
  /** Human-readable reason, shown verbatim next to the badge. */
  detail: string;
}

export function blankPeerIdentity(nodeId: number, name: string, now: number): PeerIdentity {
  return {
    nodeId,
    publicKeyHex: '',
    name,
    firstSeen: now,
    verifiedAt: 0,
    trustedAt: 0,
    state: 'unknown',
    detail: 'not yet challenged',
  };
}

export interface VerifyInput {
  /** What arrived. */
  res: IdentResPayload;
  /** The node id the packet actually came from, per the header. */
  srcId: number;
  /** The challenge this node issued, or null if it issued none. */
  expectedNonce: Uint8Array | null;
  /** What was already known about this peer, if anything. */
  known: PeerIdentity | null;
  now: number;
}

/**
 * Decides what an IDENT_RES proves.
 *
 * Every rejection below is a separate failure with a separate meaning, and they
 * are kept apart on purpose. "The signature was bad" and "the signature was
 * fine but this is a different key than last time" look the same to a
 * pass/fail check and mean completely different things to a person: the first
 * is noise or a bug, the second is either a reinstall or somebody standing
 * between two phones.
 */
export function judge(input: VerifyInput): PeerIdentity {
  const { res, srcId, expectedNonce, known, now } = input;
  const base =
    known ?? blankPeerIdentity(srcId, res.name, now);
  const reject = (state: TrustState, detail: string): PeerIdentity => ({
    ...base,
    state,
    detail,
  });

  if (!expectedNonce) {
    // Nothing was asked, so nothing is being answered. An unsolicited IDENT_RES
    // is either a replay or a peer confused about who it is talking to; either
    // way it must not be allowed to overwrite a state a real exchange produced.
    return reject(base.state === 'pending' ? 'unknown' : base.state, 'unsolicited response ignored');
  }

  if (!sameBytes(res.nonce, expectedNonce)) {
    return reject('failed', 'answered a challenge we did not send');
  }

  const claimedId = nodeIdFor(res.pubKey);
  if (claimedId !== srcId) {
    // The id is a hash of the key. A packet whose source id is not that hash is
    // using an id it has no claim to, whatever else is valid about it.
    return reject('failed', 'node id does not match the key that signed');
  }

  const message = identChallengeBytes(res.nonce, srcId, res.name);
  if (!verify(res.sig, message, res.pubKey)) {
    return reject('failed', 'signature did not verify');
  }

  const publicKeyHex = toHex(res.pubKey);

  // Trust-on-first-use, with the second use actually checked. A peer whose key
  // has changed is not quietly re-verified: the previous verification was of a
  // key, and that key is gone.
  if (base.publicKeyHex && base.publicKeyHex !== publicKeyHex) {
    return {
      ...base,
      publicKeyHex,
      name: res.name,
      verifiedAt: now,
      trustedAt: 0,
      state: 'mismatch',
      detail: 'this id is signing with a different key than before',
    };
  }

  return {
    ...base,
    publicKeyHex,
    name: res.name,
    verifiedAt: now,
    state: base.trustedAt ? 'trusted' : 'verified',
    detail: base.trustedAt ? 'safety number confirmed in person' : 'key proven, not yet compared',
  };
}

/**
 * Records that a person compared the safety number and it matched.
 *
 * Only legal from `verified`: confirming a fingerprint for a peer that never
 * proved possession of the key would be confirming a photograph of a stranger.
 */
export function confirmInPerson(peer: PeerIdentity, now: number): PeerIdentity {
  if (peer.state !== 'verified') return peer;
  return { ...peer, trustedAt: now, state: 'trusted', detail: 'safety number confirmed in person' };
}

/** Undoes a confirmation, back to the cryptographic fact underneath it. */
export function revokeTrust(peer: PeerIdentity): PeerIdentity {
  if (!peer.verifiedAt) return { ...peer, trustedAt: 0, state: 'unknown', detail: 'not yet challenged' };
  return { ...peer, trustedAt: 0, state: 'verified', detail: 'key proven, not yet compared' };
}

/** The peer's key as bytes, for a safety number. Empty when never verified. */
export function peerPublicKey(peer: PeerIdentity): Uint8Array {
  return peer.publicKeyHex ? fromHex(peer.publicKeyHex) : new Uint8Array(0);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // Not constant-time, and it does not need to be: the value being compared is
  // a nonce this node generated and is about to discard, not a secret.
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
