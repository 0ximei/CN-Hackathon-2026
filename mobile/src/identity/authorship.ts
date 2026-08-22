import { sha256 } from '@noble/hashes/sha2.js';

import { nodeIdFor, verify } from './keys';

/**
 * Who wrote a document, provable by anyone who receives it.
 *
 * The mesh already proves *node* identity: a peer answers a challenge with a
 * signature and its id is the hash of its key, so claiming an id and proving it
 * are the same act. That says nothing about a document. A file crosses several
 * hops, is re-announced by nodes that did not write it, and arrives at phones
 * that have never met its author — so the attestation has to travel with the
 * document rather than with the link it came over.
 *
 * Three things are checked, and they answer different questions:
 *
 *  1. **The signature verifies** under the key that travels with the document.
 *     Somebody holding that private key attested to this exact manifest.
 *  2. **The key hashes to the claimed author id.** Without this, step 1 proves
 *     only that *someone* signed it — an attacker can always sign their own
 *     forgery with their own key and staple it to a stolen author id.
 *  3. **The content hashes to what was signed.** Steps 1 and 2 cover the
 *     manifest; this is what covers the bytes, and it can only be checked once
 *     the body is actually held.
 *
 * What this deliberately does not claim: that the author is a particular
 * *person*. It binds a document to a keypair, and binding a keypair to a human
 * is what the safety-number comparison in `trust.ts` is for.
 */

export const DOC_HASH_BYTES = 32;
export const SIGNATURE_BYTES = 64;
export const PUBLIC_KEY_BYTES = 32;

/** Domain separator, so a document signature is not an identity proof. */
const CONTENT_TAG = 'meshnet/doc-content-v1\n';
const MANIFEST_TAG = 'meshnet/doc-manifest-v1\n';

export interface DocManifest {
    docKey: number;
    /** SHA-256 of the document's content. See [hashDocument]. */
    docHash: Uint8Array;
    title: string;
    source: string;
    chunkCount: number;
    /** Total body bytes, as the author counted them. */
    bytes: number;
    createdAtSec: number;
    /** The node id claiming to have written it. */
    authorId: number;
}

export type Authorship =
    /** No signature travelled with it — the built-in corpus, or an old build. */
    | 'unsigned'
    /** Signature good, and the key really does hash to the claimed author. */
    | 'verified'
    /** A signature was present and did not check out. Do not show the author. */
    | 'forged';

/**
 * SHA-256 over the document's content.
 *
 * Title and body only. `source` is a filename and is covered by the signed
 * manifest instead: including it here would mean a receiver could not
 * recompute the hash without also agreeing on how the filename was normalised,
 * and a check that cannot be run is worse than one that is narrower.
 *
 * The body is the chunk texts joined the same way `docKeyOf` joins them, so
 * both identifiers are derived from exactly the same bytes.
 */
export function hashDocument(title: string, chunks: string[]): Uint8Array {
    return sha256(utf8(`${CONTENT_TAG}${title}\n${chunks.join('\n')}`));
}

/**
 * The exact bytes an author signs.
 *
 * Every variable-length field is length-prefixed. Without that, a manifest with
 * title "ab" and source "c" encodes identically to one with title "a" and
 * source "bc", and a signature over one would verify the other — which is a
 * free way to relabel someone else's document.
 */
export function manifestBytes(m: DocManifest): Uint8Array {
    const title = utf8(m.title);
    const source = utf8(m.source);
    const tag = utf8(MANIFEST_TAG);
    const out = new Uint8Array(
        tag.length + 4 * 5 + 2 + title.length + 2 + source.length + DOC_HASH_BYTES,
    );
    const dv = new DataView(out.buffer);
    let o = 0;
    out.set(tag, o);
    o += tag.length;
    for (const n of [m.docKey, m.authorId, m.chunkCount, m.bytes, m.createdAtSec]) {
        dv.setUint32(o, n >>> 0);
        o += 4;
    }
    dv.setUint16(o, title.length);
    o += 2;
    out.set(title, o);
    o += title.length;
    dv.setUint16(o, source.length);
    o += 2;
    out.set(source, o);
    o += source.length;
    out.set(fixed(m.docHash, DOC_HASH_BYTES), o);
    return out;
}

/**
 * Whether this document really came from the node it names.
 *
 * Never throws: a malformed key or signature arriving off the radio is a failed
 * verification, not a crash.
 */
export function verifyAuthorship(
    m: DocManifest,
    sig: Uint8Array | undefined,
    authorKey: Uint8Array | undefined,
): Authorship {
    if (!sig?.length && !authorKey?.length) return 'unsigned';
    if (!sig || !authorKey) return 'forged';
    if (sig.length !== SIGNATURE_BYTES || authorKey.length !== PUBLIC_KEY_BYTES) return 'forged';
    // The binding that makes the rest mean anything. A forger can sign their
    // own manifest perfectly well; what they cannot do is find a key that
    // hashes to somebody else's node id.
    if (nodeIdFor(authorKey) !== (m.authorId >>> 0)) return 'forged';
    return verify(sig, manifestBytes(m), authorKey) ? 'verified' : 'forged';
}

/** Whether the bytes on disk are the bytes that were signed. */
export function contentMatches(docHash: Uint8Array, title: string, chunks: string[]): boolean {
    const actual = hashDocument(title, chunks);
    if (docHash.length !== actual.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= docHash[i] ^ actual[i];
    return diff === 0;
}

function utf8(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

function fixed(a: Uint8Array, n: number): Uint8Array {
    if (a.length === n) return a;
    const out = new Uint8Array(n);
    out.set(a.subarray(0, n));
    return out;
}
