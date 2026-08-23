import { expect, it, vi } from 'vitest';

vi.mock('expo-sqlite', () => import('./__testshim__/expo-sqlite'));

/**
 * A budget on how many GATT segments one metadata packet may need.
 *
 * `BleTransport` reports a 4 KB MTU, which is true of the interface and not of
 * the link. Underneath, the native radio cuts every packet into segments capped
 * at 512 bytes — Bluetooth's ceiling on a single attribute value, which does
 * not move however large the negotiated MTU gets — and its reassembler resets
 * on the first gap, so a packet is all-or-nothing across however many segments
 * it takes. Nothing retransmits: a link that drops mid-message clears its queue
 * silently.
 *
 * Measured on the signed worst case: the authorship attestation adds 128 bytes
 * to every announcement of a document somebody actually wrote.
 *
 * That makes segments-per-packet a reliability number, not a performance one,
 * and it is invisible from every layer that would normally be reviewed. This
 * test makes it visible: raise the entries per announce, the snippet length or
 * the embedding width, and the budget is what tells you what it cost.
 */
const ATT_MTU = 517;
/** Mirrors `MeshWire.payloadCapacity`, ceiling included. */
const GATT_MAX_ATTR_LEN = 512;
const SEGMENT_BYTES =
    Math.min(ATT_MTU - 3 /* ATT overhead */, GATT_MAX_ATTR_LEN) - 1 /* segment header */;
const MAX_SEGMENTS = 4;

it('keeps one metadata packet inside its segment budget', async () => {
    const { LocalCatalog } = await import('./localCatalog');
    const { loadFixtures } = await import('../testing/documents');
    const { encodeAnnounce, HEADER_BYTES } = await import('@core/protocol/packet');

    const catalog = await LocalCatalog.open();
    await loadFixtures(catalog, 0x72);

    const byDoc = new Map<number, ReturnType<typeof catalog.metas>>();
    for (const m of catalog.metas()) byDoc.set(m.docKey, [...(byDoc.get(m.docKey) ?? []), m]);

    // Mirrors Replicator.announceDocument: the same slicing, the same worst
    // case for the strings and holder list it can carry.
    const ENTRIES_PER_ANNOUNCE = 2;
    let worst = 0;
    for (const rows of byDoc.values()) {
        for (let i = 0; i < rows.length; i += ENTRIES_PER_ANNOUNCE) {
            const slice = rows.slice(i, i + ENTRIES_PER_ANNOUNCE);
            const bytes =
                encodeAnnounce({
                    docKey: slice[0].docKey,
                    title: slice[0].title,
                    source: 'x'.repeat(120),
                    docBytes: 999999,
                    chunkCount: rows.length,
                    docOriginId: 0x71,
                    createdAtSec: Math.floor(Date.now() / 1000),
                    // The signed case, which is the one that costs: 32 bytes of
                    // content hash always, plus 96 for the key and signature.
                    docHash: new Uint8Array(32).fill(0xab),
                    authorKey: new Uint8Array(32).fill(0xcd),
                    sig: new Uint8Array(64).fill(0xef),
                    entries: slice.map((m) => ({
                        docId: m.docId,
                        seq: m.seq,
                        version: m.version,
                        section: m.section,
                        snippet: m.snippet,
                        bytes: m.bytes,
                        originId: m.originId,
                        scale: m.scale,
                        vec: m.q,
                        // A fully-replicated passage names the most holders it
                        // ever will, which is the packet's real worst case.
                        holders: [1, 2, 3, 4, 5, 6, 7, 8],
                        hits: 0,
                    })),
                }).length + HEADER_BYTES;
            worst = Math.max(worst, bytes);
        }
    }

    const segments = Math.ceil((worst + 1) / SEGMENT_BYTES);
    expect(
        segments,
        `worst ANNOUNCE is ${worst}B = ${segments} segments that must all survive the link`,
    ).toBeLessThanOrEqual(MAX_SEGMENTS);
});
