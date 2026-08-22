import { afterEach, describe, expect, it, vi } from 'vitest';

import { MockTransport } from '@core/protocol/testHarness';
import type { Identity } from '@core/lib/ids';

import { MeshNode } from './MeshNode';
import { MemoryCatalog } from '../storage/MemoryCatalog';

/**
 * An uploaded file has to survive the whole trip, not just the first hop of it.
 *
 * The existing coverage stops at "the late joiner learned about the passage",
 * which is the metadata tier. What a user actually does is tap the result to
 * read it, and that is a separate packet exchange against a separate tier —
 * the body is deliberately *not* replicated with the metadata. Nothing tested
 * that half, which is exactly the half being reported broken.
 */

const SNAKEBITE =
    '# Snake Bite\n\nKeep the person still and calm; immobilise the bitten limb below heart level and seek antivenom urgently. Do not cut the wound or attempt to suck out venom.';

function identity(id: number, name: string): Identity {
    return { uuid: `uuid-${id}`, id, name };
}

function build(id: number, name: string) {
    const transport = new MockTransport(`link-${id}`);
    const catalog = new MemoryCatalog();
    return { node: new MeshNode(identity(id, name), transport, catalog), transport, catalog };
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

describe('uploading a file', () => {
    it('is readable in full on a node that only heard the metadata', async () => {
        vi.useFakeTimers();
        const a = build(0x71, 'Uploader');
        const b = build(0x72, 'Reader');

        a.transport.link(b.transport);
        await startAll(a.node, b.node);
        await a.node.upload('snakebite.md', SNAKEBITE);

        // Beacons, then the one-shot catalog sync a few seconds behind them.
        await vi.advanceTimersByTimeAsync(15_000);

        expect(b.catalog.knownCount, 'B learned the passage exists').toBeGreaterThan(0);

        vi.useRealTimers();
        const state = await b.node.search('immobilise a snake bite');
        const hit = state.hits.find((h) => h.title === 'Snake Bite');
        expect(hit, 'B can find the uploaded passage').toBeDefined();

        // The part nothing covered: B holds no body, so this is a DOC_REQ to A
        // and back, not a local read.
        expect(b.catalog.holdsBody(hit!.docId), 'B has metadata only').toBe(false);
        const text = await b.node.fetchFullText(hit!);
        expect(text, 'B pulled the passage body from A').toContain('antivenom');
    });

    it('reaches a node that is already storing all it can hold', async () => {
        vi.useFakeTimers();
        const a = build(0x73, 'Uploader');
        const b = build(0x74, 'FullDisk');
        // No room for a single body, but discovery must still work: knowing
        // about a passage and being able to serve it are different tiers.
        await b.catalog.setBudget(1);

        a.transport.link(b.transport);
        await startAll(a.node, b.node);
        await a.node.upload('snakebite.md', SNAKEBITE);
        await vi.advanceTimersByTimeAsync(15_000);

        expect(b.catalog.knownCount, 'a full node still learns what exists').toBeGreaterThan(0);

        vi.useRealTimers();
        const state = await b.node.search('immobilise a snake bite');
        const hit = state.hits.find((h) => h.title === 'Snake Bite');
        expect(hit, 'and can still find it').toBeDefined();
        expect(await b.node.fetchFullText(hit!)).toContain('antivenom');
    });
});

describe('a catalog sync that does not get through', () => {
    /**
     * The one-shot sync is the only fast path an upload has to a peer that was
     * not listening when it happened — the periodic re-announcement walks one
     * document a minute, so on a real library it is many minutes behind. On the
     * radio this app actually runs on, links drop mid-exchange constantly, so
     * "sent once, never checked" is not an edge case.
     */
    it('is retried until the peer actually answers', async () => {
        vi.useFakeTimers();
        const a = build(0x75, 'Uploader');
        const b = build(0x76, 'Reader');

        await startAll(a.node);
        await a.node.upload('snakebite.md', SNAKEBITE);

        // B arrives, and the link swallows everything B sends to A: the request
        // leaves B and never lands. This is a frame lost on the radio, not a
        // severed link — nothing parks it and nothing reports it.
        a.transport.link(b.transport);
        await startAll(b.node);
        a.node.packetLoss = 1;

        await vi.advanceTimersByTimeAsync(10_000);
        expect(b.catalog.knownCount, 'nothing arrived while the link was eating packets').toBe(0);

        // The link comes good. Well inside the one-minute re-announcement walk,
        // so recovery has to come from the sync itself.
        a.node.packetLoss = 0;
        await vi.advanceTimersByTimeAsync(45_000);

        expect(b.catalog.knownCount, 'the sync recovered on its own').toBeGreaterThan(0);
    });
});
