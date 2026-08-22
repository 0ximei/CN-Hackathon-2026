import { afterEach, describe, expect, it, vi } from 'vitest';

import { MockTransport } from '@core/protocol/testHarness';
import type { Identity } from '@core/lib/ids';
import type { Scored } from '@core/search/vector';
import { docIdOf, docKeyOf, type ParsedDoc } from '@core/lib/chunk';

import { MeshNode, type MeshCatalog, type MeshHit } from './MeshNode';
import { embedder } from '../search/embedder';
import type { CatalogStats, StoredChunk } from '../storage/store';

/**
 * The catalog reduced to what the orchestrator uses.
 *
 * The real one is SQLite behind expo-sqlite, which needs a device. Everything
 * these tests are about — who answers, which way replies travel, what happens
 * when they cannot — is indifferent to the database underneath.
 */
class MemoryCatalog implements MeshCatalog {
    private chunks = new Map<number, StoredChunk>();
    private outbox: { id: number; dstId: number; payload: string; expiresAt: number }[] = [];
    private nextId = 1;

    add(docId: number, title: string, text: string): void {
        this.chunks.set(docId, {
            docId,
            docKey: 1,
            seq: 0,
            title,
            section: '',
            source: 'test',
            text,
            provenance: 'seed',
        });
    }

    chunksOf(docKey: number): StoredChunk[] {
        return [...this.chunks.values()]
            .filter((c) => c.docKey === docKey)
            .sort((a, b) => a.seq - b.seq);
    }

    async ingestDoc(
        doc: ParsedDoc,
        filter: ((docId: number) => boolean) | undefined,
        provenance: 'seed' | 'local',
    ): Promise<number> {
        const body = doc.chunks.map((c) => c.text).join('\n');
        const docKey = docKeyOf(doc.title, body);
        let written = 0;
        for (let seq = 0; seq < doc.chunks.length; seq++) {
            const chunk = doc.chunks[seq];
            const docId = docIdOf(docKey, seq, chunk.text);
            if (filter && !filter(docId)) continue;
            this.chunks.set(docId, {
                docId,
                docKey,
                seq,
                title: doc.title,
                section: chunk.section,
                source: doc.source,
                text: chunk.text,
                provenance,
            });
            written++;
        }
        return written;
    }

    async ingestRemote(chunk: Omit<StoredChunk, 'provenance'>): Promise<boolean> {
        if (this.chunks.has(chunk.docId)) return false;
        this.chunks.set(chunk.docId, { ...chunk, provenance: 'mesh' });
        return true;
    }

    async reload(): Promise<void> {
        // In-memory map is always current — nothing to rebuild.
    }

    search(queryVec: Float32Array, _queryText: string, k: number): Scored[] {
        const scored: Scored[] = [];
        for (const chunk of this.chunks.values()) {
            const vec = embedder.embed(chunk.text);
            let dot = 0;
            for (let i = 0; i < vec.length; i++) dot += vec[i] * queryVec[i];
            if (dot > 0.05) scored.push({ docId: chunk.docId, score: dot });
        }
        return scored.sort((a, b) => b.score - a.score).slice(0, k);
    }

    chunk(docId: number): StoredChunk | undefined {
        return this.chunks.get(docId);
    }

    snippet(docId: number): string {
        const text = this.chunks.get(docId)?.text ?? '';
        return text.length > 200 ? `${text.slice(0, 199)}…` : text;
    }

    stats(): CatalogStats {
        return { documents: this.chunks.size ? 1 : 0, chunks: this.chunks.size, bytes: 0 };
    }

    async enqueue(dstId: number, payload: string, ttlMs: number): Promise<void> {
        this.outbox.push({ id: this.nextId++, dstId, payload, expiresAt: Date.now() + ttlMs });
    }

    async dueFor(dstId?: number): Promise<{ id: number; dstId: number; payload: string }[]> {
        return this.outbox.filter((r) => dstId === undefined || r.dstId === dstId);
    }

    async dequeue(id: number): Promise<void> {
        this.outbox = this.outbox.filter((r) => r.id !== id);
    }

    async queuedCount(): Promise<number> {
        return this.outbox.length;
    }
}

const TOURNIQUET =
    'A tourniquet is applied high and tight above the wound and tightened until the bleeding stops.';
const BOILING = 'Purify water by bringing it to a rolling boil for at least one full minute.';

function identity(id: number, name: string): Identity {
    return { uuid: `uuid-${id}`, id, name };
}

interface Built {
    node: MeshNode;
    transport: MockTransport;
    catalog: MemoryCatalog;
}

function build(id: number, name: string): Built {
    const transport = new MockTransport(`link-${id}`);
    const catalog = new MemoryCatalog();
    const node = new MeshNode(identity(id, name), transport, catalog);
    return { node, transport, catalog };
}

const started: MeshNode[] = [];

async function startAll(...nodes: MeshNode[]): Promise<void> {
    for (const node of nodes) {
        await node.start();
        started.push(node);
    }
}

afterEach(() => {
    while (started.length) started.pop()?.stop();
    vi.useRealTimers();
});

describe('MeshNode over a simulated mesh', () => {
    /**
     * The whole point of the project in one assertion: a passage that exists on
     * no node the user can see, found anyway, and correctly attributed to the
     * node two hops away that actually holds it.
     */
    it('returns a passage held only by a node two hops away', async () => {
        const a = build(0x0a, 'Alpha');
        const b = build(0x0b, 'Bravo');
        const c = build(0x0c, 'Charlie');

        c.catalog.add(101, 'Bleeding', TOURNIQUET);
        a.catalog.add(202, 'Water', BOILING);

        a.transport.link(b.transport);
        b.transport.link(c.transport);

        await startAll(a.node, b.node, c.node);

        const state = await a.node.search('how tight should a tourniquet be');
        const hit = state.hits.find((h) => h.docId === 101);

        expect(hit, 'the far passage came back').toBeDefined();
        expect(hit!.local).toBe(false);
        expect(hit!.fromNodeId).toBe(0x0c);
        // Named, not shown as a hex id: beacons flood periodically, so a node
        // learns what its non-neighbours are called.
        expect(hit!.fromNodeName).toBe('Charlie');
        expect(hit!.hops).toBe(2);
    });

    it('answers from local storage with no radio involved', async () => {
        const solo = build(0x11, 'Solo');
        solo.catalog.add(303, 'Water', BOILING);

        await startAll(solo.node);

        const state = await solo.node.search('how long should I boil water');
        const hit = state.hits.find((h) => h.docId === 303);

        expect(hit).toBeDefined();
        expect(hit!.local).toBe(true);
        expect(hit!.hops).toBe(0);
        // Held here, so the body is present without any fetch.
        expect(hit!.text).toBe(BOILING);
    });

    /**
     * Snippets ride inside RESULT packets; bodies do not. A remote hit therefore
     * arrives truncated, and opening it has to cost a DOC_REQ round trip.
     */
    it('fetches the full passage on demand, not with the result', async () => {
        const a = build(0x21, 'Asker');
        const b = build(0x22, 'Holder');

        const long = `${TOURNIQUET} `.repeat(6).trim();
        b.catalog.add(404, 'Bleeding', long);

        a.transport.link(b.transport);
        await startAll(a.node, b.node);

        const state = await a.node.search('tourniquet above the wound');
        const hit = state.hits.find((h) => h.docId === 404)!;

        expect(hit).toBeDefined();
        expect(hit.text, 'the body does not travel with the result').toBeUndefined();
        expect(hit.snippet.length).toBeLessThan(long.length);

        const body = await a.node.fetchFullText(hit);
        expect(body).toBe(long);
    });

    it('parks a unicast that has nowhere to go, instead of dropping it', async () => {
        vi.useFakeTimers();
        const a = build(0x31, 'Lonely');
        // Deliberately not started: this exercises the routing decision, and a
        // running node would only add beacons nobody is there to hear.

        const orphan: MeshHit = {
            docId: 505,
            score: 0.9,
            title: 'Bleeding',
            section: '',
            snippet: 'a snippet',
            fromNodeId: 0x99,
            fromNodeName: 'Gone',
            holderId: 0x99,
            holderName: 'Gone',
            hops: 2,
            local: false,
            storedHere: false,
        };

        const pending = a.node.fetchFullText(orphan);
        await vi.advanceTimersByTimeAsync(0);

        expect(await a.catalog.queuedCount(), 'DOC_REQ was queued for later').toBe(1);

        // And the caller is not left hanging: it degrades to the snippet.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await pending).toBe('a snippet');
    });

    /**
     * The point of Feature A: an upload does not just sit in the uploader's own
     * catalog — it gossips out via ANNOUNCE, and a linked peer pulls the body in
     * on its own, unprompted, without ever having searched for it.
     */
    it('replicates an upload to a linked peer via ANNOUNCE', async () => {
        const a = build(0x41, 'Uploader');
        const b = build(0x42, 'Neighbour');
        a.transport.link(b.transport);
        await startAll(a.node, b.node);

        const replicated = new Promise<void>((resolve) => {
            const off = b.node.on('catalog', (stats) => {
                if (stats.chunks > 0) {
                    off();
                    resolve();
                }
            });
        });

        await a.node.upload(
            'burns.md',
            '# Burns\n\nCool a burn under running water for about twenty minutes to limit tissue damage.',
        );
        await replicated;

        expect(b.catalog.stats().chunks).toBeGreaterThan(0);

        const state = await b.node.search('cool a burn under water');
        const hit = state.hits.find((h) => h.title === 'Burns');
        expect(hit, 'the pulled passage is now searchable locally on Bravo').toBeDefined();
        expect(hit!.local).toBe(true);
    });
});
