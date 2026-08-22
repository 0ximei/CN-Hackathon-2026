import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-sqlite', () => import('./__testshim__/expo-sqlite'));

const UPLOAD =
    '# Snake Bite\n\nKeep the person still and calm; immobilise the bitten limb below heart level and seek antivenom urgently.';

async function open() {
    const { LocalCatalog } = await import('./localCatalog');
    return LocalCatalog.open();
}

describe('LocalCatalog on real SQLite', () => {
    beforeEach(() => vi.resetModules());

    it('keeps an uploaded document findable, holdable and servable', async () => {
        const catalog = await open();
        const { doc } = await catalog.upload('snakebite.md', UPLOAD, 0x71);

        expect(catalog.docRow(doc.docKey), 'the document row is on disk').toBeDefined();
        const metas = catalog.metas().filter((m) => m.docKey === doc.docKey);
        expect(metas.length, 'its passages are indexed').toBeGreaterThan(0);

        for (const m of metas) {
            expect(catalog.holdsBody(m.docId), 'the uploader is the first replica').toBe(true);
            expect(await catalog.getBody(m.docId), 'and can serve the body').toBeTruthy();
        }
    });

    it('replicates an upload to a second node that can then read it', async () => {
        // Both ends on real SQLite, which is the combination nothing covered:
        // every other test in this project runs the protocol against
        // `MemoryCatalog`, so the storage layer that actually ships has never
        // been on either side of a replication.
        const { MeshNode } = await import('../mesh/MeshNode');
        const { MockTransport } = await import('@core/protocol/testHarness');

        const aCatalog = await open();
        const bCatalog = await open();
        const aLink = new MockTransport('link-a');
        const bLink = new MockTransport('link-b');
        aLink.link(bLink);

        const a = new MeshNode({ uuid: 'a', id: 0x71, name: 'Uploader' }, aLink, aCatalog);
        const b = new MeshNode({ uuid: 'b', id: 0x72, name: 'Reader' }, bLink, bCatalog);
        try {
            vi.useFakeTimers();
            await a.start();
            await b.start();
            await a.upload('snakebite.md', UPLOAD);
            await vi.advanceTimersByTimeAsync(15_000);

            expect(bCatalog.knownCount, 'B learned the passage exists').toBeGreaterThan(0);

            vi.useRealTimers();
            const state = await b.search('immobilise a snake bite');
            const hit = state.hits.find((h) => h.title === 'Snake Bite');
            expect(hit, 'B can find the uploaded passage').toBeDefined();
            expect(await b.fetchFullText(hit!), 'B can read its body').toContain('antivenom');
        } finally {
            vi.useRealTimers();
            a.stop();
            b.stop();
        }
    });

    it('lists the upload among its documents', async () => {
        const catalog = await open();
        await catalog.upload('snakebite.md', UPLOAD, 0x71);
        const titles = catalog.documents().map((d) => d.title);
        expect(titles).toContain('Snake Bite');
    });
});

describe('a mesh that is already carrying the built-in corpus', () => {
    /**
     * Every other test starts from an empty catalog. A real device never does:
     * it launches, seeds thirty-odd documents against a 1 MiB budget, and only
     * then meets a peer. Whether an upload survives *that* is the question the
     * empty-catalog tests cannot answer.
     */
    it('still replicates an upload between two seeded nodes', async () => {
        const { MeshNode } = await import('../mesh/MeshNode');
        const { MockTransport } = await import('@core/protocol/testHarness');
        const { seedCorpus } = await import('../mesh/bootstrap');

        const aCatalog = await open();
        const bCatalog = await open();
        await seedCorpus(aCatalog as never, 0x71);
        await seedCorpus(bCatalog as never, 0x72);

        const seededKnown = bCatalog.knownCount;
        const seededUsage = await bCatalog.usage();
        expect(seededKnown, 'B starts out knowing the corpus').toBeGreaterThan(0);

        const aLink = new MockTransport('link-a');
        const bLink = new MockTransport('link-b');
        aLink.link(bLink);
        const a = new MeshNode({ uuid: 'a', id: 0x71, name: 'Uploader' }, aLink, aCatalog);
        const b = new MeshNode({ uuid: 'b', id: 0x72, name: 'Reader' }, bLink, bCatalog);

        try {
            vi.useFakeTimers();
            await a.start();
            await b.start();
            a.startReplication();
            b.startReplication();
            await a.upload('snakebite.md', UPLOAD);
            await vi.advanceTimersByTimeAsync(30_000);

            const listed = bCatalog.documents().find((d) => d.title === 'Snake Bite');
            expect(
                listed,
                `B lists the upload (knew ${seededKnown}, ${seededUsage.freeBytes}B free)`,
            ).toBeDefined();
        } finally {
            vi.useRealTimers();
            a.stop();
            b.stop();
        }
    });
});
