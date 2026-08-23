import { afterEach, describe, expect, it, vi } from 'vitest';

import { MockTransport } from '@core/protocol/testHarness';
import { parseDocument } from '@core/lib/chunk';
import type { Identity } from '@core/lib/ids';

import { MeshNode } from './MeshNode';
import { MemoryCatalog } from '../storage/MemoryCatalog';
import { LIBRARY_DOCS } from '../testing/documents';

/**
 * How much of the radio the mesh may spend on itself.
 *
 * This file exists because of a regression that took a working two-phone demo
 * down to zero peers. Replication refreshes holder claims by gossiping them,
 * and the first implementation refreshed them by re-sending the ANNOUNCE that
 * originally carried them — a 384-byte embedding and a 200-byte snippet per
 * chunk, about 660 bytes, to carry roughly twenty bytes that had actually
 * changed. On the browser build, over a BroadcastChannel, that is free. Over
 * BLE at a 517-byte MTU it came to about 1 KB/s flooded to every link, and
 * double that through a relay.
 *
 * The failure is indirect and that is what makes it worth a test. The links
 * stayed up. What broke is that HELLO beacons queued behind metadata and missed
 * the peer-liveness deadline, so nodes declared each other dead over links that
 * were working — a mesh reporting no peers while the radio log shows traffic.
 *
 * A few kB/s is the whole link budget, so the mesh's own overhead is capped
 * here at a few hundred bytes a second, leaving the rest for queries, bodies,
 * and the beacons that keep the thing alive.
 */
const MAX_STEADY_STATE_BYTES_PER_SECOND = 400;

function identity(id: number, name: string): Identity {
    return { uuid: `uuid-${id}`, id, name };
}

/** Counts every byte handed to the radio, which is what a link actually pays. */
function metered(transport: MockTransport): { bytes: () => number; reset: () => void } {
    let total = 0;
    const send = transport.send.bind(transport);
    const broadcast = transport.broadcast.bind(transport);
    transport.send = (peerId, frame) => {
        total += frame.length;
        send(peerId, frame);
    };
    transport.broadcast = (frame, except) => {
        total += frame.length;
        broadcast(frame, except);
    };
    return { bytes: () => total, reset: () => (total = 0) };
}

const started: MeshNode[] = [];

afterEach(() => {
    while (started.length) started.pop()?.stop();
    vi.useRealTimers();
});

describe('airtime', () => {
    it('keeps steady-state gossip inside the link budget', async () => {
        vi.useFakeTimers();

        const aTransport = new MockTransport('link-a');
        const bTransport = new MockTransport('link-b');
        const aCatalog = new MemoryCatalog();
        const bCatalog = new MemoryCatalog();
        const a = new MeshNode(identity(0xa1, 'Alpha'), aTransport, aCatalog);
        const b = new MeshNode(identity(0xb1, 'Bravo'), bTransport, bCatalog);

        // A real library on both nodes. The budget is only meaningful against
        // one: a node holding three documents gossips almost nothing, and the
        // regression this guards showed up at scale.
        for (const doc of LIBRARY_DOCS) {
            const parsed = parseDocument(doc.file, doc.markdown);
            await aCatalog.ingestParsed(parsed, 0xa1, 'local');
            await bCatalog.ingestParsed(parsed, 0xb1, 'local');
        }
        expect(aCatalog.knownCount).toBeGreaterThan(30);

        aTransport.link(bTransport);
        for (const node of [a, b]) {
            await node.start();
            started.push(node);
        }
        // Let both learn about each other, and let the one-shot catalog sync
        // and its settle delay pass: this measures the *steady* state, not the
        // introduction, which is allowed to be expensive once.
        await vi.advanceTimersByTimeAsync(15_000);

        a.startReplication();
        b.startReplication();
        await vi.advanceTimersByTimeAsync(10_000);

        const meter = metered(aTransport);
        meter.reset();
        const windowMs = 60_000;
        await vi.advanceTimersByTimeAsync(windowMs);

        const perSecond = meter.bytes() / (windowMs / 1000);
        expect(
            perSecond,
            `steady-state gossip is ${perSecond.toFixed(0)} B/s, over the ${MAX_STEADY_STATE_BYTES_PER_SECOND} B/s budget`,
        ).toBeLessThan(MAX_STEADY_STATE_BYTES_PER_SECOND);
    });

    /**
     * A brand-new link should carry a beacon before it carries a catalog.
     *
     * The first seconds of a BLE link are the expensive ones, and a peer that
     * cannot get a HELLO through inside the liveness deadline is a peer this
     * node will shortly declare dead — so nothing large may be queued ahead of
     * the first beacons.
     */
    it('does not flood a link in its first seconds', async () => {
        vi.useFakeTimers();

        const aTransport = new MockTransport('link-a');
        const bTransport = new MockTransport('link-b');
        const aCatalog = new MemoryCatalog();
        const a = new MeshNode(identity(0xa2, 'Alpha'), aTransport, aCatalog);
        const b = new MeshNode(identity(0xb2, 'Bravo'), bTransport, new MemoryCatalog());

        for (const doc of LIBRARY_DOCS) {
            await aCatalog.ingestParsed(parseDocument(doc.file, doc.markdown), 0xa2, 'local');
        }

        for (const node of [a, b]) {
            await node.start();
            started.push(node);
        }
        a.startReplication();

        const meter = metered(aTransport);
        meter.reset();
        aTransport.link(bTransport);
        await vi.advanceTimersByTimeAsync(4_000);

        // Four seconds of a fresh link: beacons and a challenge, nothing that
        // would take a slow radio more than a moment to move.
        expect(meter.bytes()).toBeLessThan(1024);
    });
});
