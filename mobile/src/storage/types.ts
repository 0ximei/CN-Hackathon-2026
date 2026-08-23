import type { Authorship } from '../identity/authorship';

import type { Scored } from '@core/search/vector';

/**
 * Where a document came from, for the Library.
 *
 * Not a security property and not used by replication — it exists so the UI
 * can distinguish "you put this here", "the built-in corpus" and "this arrived
 * from the mesh", which are three different answers to "why is this on my
 * phone".
 */
/**
 * Where a document came from. Nothing ships one any more, so a node holds only
 * what a person put there and what the mesh carried to it.
 */
export type Provenance = 'local' | 'mesh';

/** A document as somebody uploaded it. Chunks point back at this. */
export interface DocRow {
    /** Content hash of the whole document — stable across nodes. */
    docKey: number;
    title: string;
    /** Filename, or whatever the `source:` line in the markdown said. */
    source: string;
    /** Total body bytes across every chunk, as the origin counted them. */
    bytes: number;
    chunkCount: number;
    /** Node that first uploaded it, and the one the signature names. */
    originId: number;
    createdAt: number;
    provenance: Provenance;
    /**
     * SHA-256 of the content. Empty for the built-in corpus and for anything
     * that arrived from a build predating the attestation.
     */
    docHash?: Uint8Array;
    /** The author's Ed25519 key and its signature over the manifest. */
    authorKey?: Uint8Array;
    sig?: Uint8Array;
    /** The verdict reached when this row was written. Never re-derived on read. */
    authorship: Authorship;
}

/**
 * Per-chunk metadata: the cheap, widely-replicated tier.
 *
 * Carries the embedding, so a node holding only this can still score the chunk
 * against a query and answer "I know something relevant, and here is who has
 * it" without holding a byte of the passage.
 */
export interface MetaRow {
    docId: number;
    docKey: number;
    seq: number;
    title: string;
    section: string;
    /** First ~200 characters of the body — enough to rank and to preview. */
    snippet: string;
    /** int8-quantized embedding: real = q * scale. */
    q: Int8Array;
    scale: number;
    /** Size of the body this describes, so a receiver can budget before pulling. */
    bytes: number;
    originId: number;
    /** Lamport-ish version so gossip converges on the newest copy. */
    version: number;
    updatedAt: number;
}

/** The expensive tier. Present only on nodes chosen to hold this chunk. */
export interface BodyRow {
    docId: number;
    text: string;
    storedAt: number;
    /** Last time a query or fetch touched it; drives eviction order. */
    touchedAt: number;
}

/** Observed body holders, one row per (chunk, node). Grow-and-expire. */
export interface HolderRow {
    docId: number;
    nodeId: number;
    seenAt: number;
}

/** Popularity as a grow-only counter partitioned by node. */
export interface PopRow {
    docId: number;
    nodeId: number;
    hits: number;
    updatedAt: number;
}

/** What this node has observed about a peer, for replica placement. */
export interface PeerStatRow {
    nodeId: number;
    firstSeen: number;
    lastSeen: number;
    helloSeen: number;
    helloExpected: number;
    requests: number;
    responses: number;
    freeBytes: number;
}

export interface CatalogStats {
    documents: number;
    /** Chunks this node has metadata for — what it can search. */
    known: number;
    /** Chunks this node holds the body of — what it can serve. */
    stored: number;
    metaBytes: number;
    bodyBytes: number;
}

/** One row in the Library. */
export interface DocSummary {
    docKey: number;
    title: string;
    source: string;
    provenance: Provenance;
    originId: number;
    /** Chunks of this document this node has metadata for. */
    chunks: number;
    /** ...and how many of those it holds the body of. */
    storedHere: number;
    /** Body bytes across the whole document, as announced by the origin. */
    bytes: number;
    createdAt: number;
}

/**
 * Fixed overhead per metadata row: the 384-byte vector plus scale and ids.
 *
 * The honest note from the web build applies here too — this is a *fixed* cost,
 * so the saving over storing the body scales with how long passages are. On the
 * short first-aid samples it is nearly half a body; on a real manual it is a
 * third to a sixth.
 */
export const META_FIXED_BYTES = 384 + 4 + 4 + 4 + 4 + 4;

export function metaBytesOf(m: Pick<MetaRow, 'title' | 'section' | 'snippet'>): number {
    return META_FIXED_BYTES + m.title.length + m.section.length + m.snippet.length;
}

/* ------------------------------------------------------------------ *
 * Ranking
 *
 * These live here rather than beside the SQLite catalog so that anything
 * needing them — the in-memory catalog the tests run against, for one — can
 * have them without pulling expo-sqlite, and therefore React Native, into a
 * plain Node process.
 * ------------------------------------------------------------------ */

/** How much of a chunk travels inside a RESULT packet or an ANNOUNCE entry. */
export const SNIPPET_CHARS = 200;

export interface LocalHit extends Scored {
    meta: MetaRow;
    /** True when this node can serve the full text without asking anyone. */
    hasBody: boolean;
}

/** A peer's identity as it was last established. See `identity/trust.ts`. */
export interface PeerIdentityRow {
    nodeId: number;
    publicKeyHex: string;
    name: string;
    firstSeen: number;
    verifiedAt: number;
    trustedAt: number;
    state: string;
    detail: string;
}
