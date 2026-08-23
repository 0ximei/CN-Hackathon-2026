import { afterEach, describe, expect, it, vi } from 'vitest';

import { MockTransport } from '@core/protocol/testHarness';
import { parseDocument } from '@core/lib/chunk';
import type { Identity } from '@core/lib/ids';

import { MeshNode } from './MeshNode';
import { MemoryCatalog } from '../storage/MemoryCatalog';
import { LIBRARY_DOCS } from '../testing/documents';

/**
 * How often the node may ask React to re-render.
 *
 * Every event this node emits is a `setState` in `useMesh`, and every one of
 * those re-renders the screen — including, on the map tab, an animated topology
 * view. The node used to emit on every packet: `activity` once per sent,
 * received, forwarded and dropped packet, plus `stats` and `outbox` after each
 * one, plus the radio's own commentary arriving as activity of its own. An idle
 * three-node mesh measured a dozen renders a second before this test existed,
 * with each `activity` payload copying a two-hundred entry array twice.
 *
 * None of those events carry a delta — each is a complete snapshot, so a later
 * one supersedes an earlier one entirely and coalescing them loses nothing.
 * Eight a second leaves room for the un-coalesced events that carry an actual
 * decision (a query result, a catalog change, an identity verdict) while
 * keeping the snapshot traffic at a rate a phone can draw.
 */
const MAX_EVENTS_PER_SECOND = 8;

function identity(id: number, name: string): Identity {
    return { uuid: `uuid-${id}`, id, name };
}

const started: MeshNode[] = [];

afterEach(() => {
    while (started.length) started.pop()?.stop();
    vi.useRealTimers();
});

describe('ui events', () => {
    it('stays inside the render budget on an idle mesh', async () => {
        vi.useFakeTimers();

        const transports = [0, 1, 2].map((i) => new MockTransport(`link-${i}`));
        const catalogs = [0, 1, 2].map(() => new MemoryCatalog());
        const nodes = [0, 1, 2].map(
            (i) => new MeshNode(identity(0xa0 + i, `Node${i}`), transports[i], catalogs[i]),
        );

        for (const doc of LIBRARY_DOCS) {
            const parsed = parseDocument(doc.file, doc.markdown);
            for (let i = 0; i < 3; i++) {
                await catalogs[i].ingestParsed(parsed, 0xa0 + i, 'local');
            }
        }

        // A line, so the middle node both relays and originates — the busiest
        // position in a three-node mesh and the one a phone actually sits in.
        transports[0].link(transports[1]);
        transports[1].link(transports[2]);

        for (const node of nodes) {
            await node.start();
            started.push(node);
        }
        await vi.advanceTimersByTimeAsync(15_000);
        for (const node of nodes) node.startReplication();
        await vi.advanceTimersByTimeAsync(10_000);

        let events = 0;
        const count = () => {
            events++;
        };
        for (const name of [
            'peers',
            'activity',
            'stats',
            'outbox',
            'routes',
            'query',
            'catalog',
            'replication',
            'identities',
        ] as const) {
            nodes[1].on(name, count as never);
        }

        const windowMs = 20_000;
        await vi.advanceTimersByTimeAsync(windowMs);

        const perSecond = events / (windowMs / 1000);
        expect(
            perSecond,
            `the node asks React to render ${perSecond.toFixed(1)} times a second, over the ${MAX_EVENTS_PER_SECOND}/s budget`,
        ).toBeLessThan(MAX_EVENTS_PER_SECOND);
    });

    /**
     * A search is the one moment the user is waiting, so its own events must
     * still arrive — coalescing must not turn "results are streaming in" into
     * "nothing happened for a quarter of a second and then everything did".
     */
    it('still reports a query as it fills in', async () => {
        vi.useFakeTimers();

        const a = new MockTransport('link-a');
        const b = new MockTransport('link-b');
        const catalogA = new MemoryCatalog();
        const catalogB = new MemoryCatalog();

        for (const doc of LIBRARY_DOCS) {
            await catalogB.ingestParsed(parseDocument(doc.file, doc.markdown), 0xb1, 'local');
        }

        const asker = new MeshNode(identity(0xa1, 'Asker'), a, catalogA);
        const holder = new MeshNode(identity(0xb1, 'Holder'), b, catalogB);
        a.link(b);
        for (const node of [asker, holder]) {
            await node.start();
            started.push(node);
        }
        await vi.advanceTimersByTimeAsync(3_100);

        let updates = 0;
        asker.on('query', () => updates++);

        const search = asker.search('how do you treat a burn');
        await vi.advanceTimersByTimeAsync(10_000);
        const state = await search;

        expect(state.hits.length).toBeGreaterThan(0);
        // Opened, filled from the peer, and closed.
        expect(updates).toBeGreaterThanOrEqual(2);
    });
});
