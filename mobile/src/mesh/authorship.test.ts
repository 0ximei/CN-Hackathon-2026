import { afterEach, describe, expect, it, vi } from 'vitest';

import { MockTransport } from '@core/protocol/testHarness';
import { fragment } from '@core/protocol/framing';
import {
    BROADCAST,
    PROTO_VERSION,
    PacketType,
    encodeAnnounce,
    encodePacket,
    type AnnouncePayload,
} from '@core/protocol/packet';
import { nextMsgId } from '@core/lib/ids';

import { MeshNode } from './MeshNode';
import { MemoryCatalog } from '../storage/MemoryCatalog';
import { keysFromSeed, nodeIdFor, sign } from '../identity/keys';
import { manifestBytes } from '../identity/authorship';

const DOC = '# Snake Bite\n\nImmobilise the bitten limb below heart level and seek antivenom urgently.';

function build(seedByte: number, name: string, signed = true) {
    const keys = keysFromSeed(new Uint8Array(32).fill(seedByte));
    const id = nodeIdFor(keys.publicKey);
    const transport = new MockTransport(`link-${id}`);
    const catalog = new MemoryCatalog();
    const node = new MeshNode(
        { uuid: `u-${id}`, id, name },
        transport,
        catalog,
        signed ? { publicKey: keys.publicKey, sign: (m) => sign(m, keys.secretKey) } : undefined,
    );
    return { node, transport, catalog, keys, id };
}

const started: MeshNode[] = [];
async function startAll(...nodes: MeshNode[]) {
    for (const n of nodes) {
        await n.start();
        started.push(n);
    }
}
afterEach(() => {
    while (started.length) started.pop()?.stop();
    vi.useRealTimers();
});

describe('an uploaded file carries proof of who wrote it', () => {
    it('arrives on another node verified, and names its author', async () => {
        vi.useFakeTimers();
        const a = build(0x11, 'Author');
        const b = build(0x22, 'Reader');
        a.transport.link(b.transport);
        await startAll(a.node, b.node);

        await a.node.upload('snakebite.md', DOC);
        await vi.advanceTimersByTimeAsync(15_000);

        const theirs = b.catalog.docRows().find((d) => d.title === 'Snake Bite');
        expect(theirs, 'the document crossed').toBeDefined();
        expect(theirs!.authorship, 'and its signature checked out').toBe('verified');
        expect(theirs!.originId, 'attributed to the node that wrote it').toBe(a.id);
        expect(theirs!.authorKey, 'with the key that proves it').toEqual(a.keys.publicKey);
        expect(theirs!.docHash?.length, 'and the hash that was signed').toBe(32);

        // The author's own copy is verified too, and by its own signature —
        // not by trusting that it is local.
        const mine = a.catalog.docRows().find((d) => d.title === 'Snake Bite');
        expect(mine!.authorship).toBe('verified');
    });

    it('rejects a relay that edits the document in flight', async () => {
        vi.useFakeTimers();
        const a = build(0x33, 'Author');
        const b = build(0x44, 'Reader');
        await startAll(a.node, b.node);
        await a.node.upload('snakebite.md', DOC);

        // A hostile relay takes the author's real, valid signature and staples
        // it to a document whose title it changed. Everything else — the key,
        // the hash, the author id — is untouched and genuine.
        const doc = a.catalog.docRows().find((d) => d.title === 'Snake Bite')!;
        const metas = a.catalog.metas().filter((m) => m.docKey === doc.docKey);
        const tampered: AnnouncePayload = {
            docKey: doc.docKey,
            title: 'Snake Bite — do not seek antivenom',
            source: doc.source,
            docBytes: doc.bytes,
            chunkCount: doc.chunkCount,
            docOriginId: doc.originId,
            createdAtSec: Math.floor(doc.createdAt / 1000),
            docHash: doc.docHash,
            authorKey: doc.authorKey,
            sig: doc.sig,
            entries: metas.map((m) => ({
                docId: m.docId,
                seq: m.seq,
                version: m.version,
                section: m.section,
                snippet: m.snippet,
                bytes: m.bytes,
                originId: m.originId,
                scale: m.scale,
                vec: m.q,
                holders: [a.id],
                hits: 0,
            })),
        };

        const bytes = encodePacket({
            ver: PROTO_VERSION,
            type: PacketType.ANNOUNCE,
            ttl: 4,
            flags: 4,
            msgId: nextMsgId(),
            srcId: 0x9999,
            dstId: BROADCAST,
            payload: encodeAnnounce(tampered),
        });
        for (const frame of fragment(bytes, b.transport.mtu)) {
            b.transport.receive('link-hostile', frame);
        }
        await vi.advanceTimersByTimeAsync(100);

        const theirs = b.catalog.docRows().find((d) => d.docKey === doc.docKey);
        expect(theirs, 'it is still ingested — the mesh does not drop data on suspicion').toBeDefined();
        expect(theirs!.authorship, 'but it is not attributed to anyone').toBe('forged');
        expect(theirs!.authorKey, 'and the key it came with is not kept').toBeUndefined();
        expect(theirs!.sig).toBeUndefined();
    });

    it('calls a document from a node with no keys unsigned, not forged', async () => {
        vi.useFakeTimers();
        const a = build(0x55, 'Keyless', false);
        const b = build(0x66, 'Reader');
        a.transport.link(b.transport);
        await startAll(a.node, b.node);

        await a.node.upload('snakebite.md', DOC);
        await vi.advanceTimersByTimeAsync(15_000);

        const theirs = b.catalog.docRows().find((d) => d.title === 'Snake Bite');
        expect(theirs).toBeDefined();
        expect(theirs!.authorship).toBe('unsigned');
    });
});
