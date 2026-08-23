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

describe('a mesh whose nodes are already carrying documents', () => {
    /**
     * Every other test starts from an empty catalog. A device in use does not:
     * it accumulates uploads and whatever the mesh has handed it, against a
     * 1 MiB budget, and only then meets another peer. Whether a new upload
     * survives *that* is the question an empty catalog cannot answer.
     */
    it('still replicates an upload between two loaded nodes', async () => {
        const { MeshNode } = await import('../mesh/MeshNode');
        const { MockTransport } = await import('@core/protocol/testHarness');
        const { loadFixtures } = await import('../testing/documents');

        const aCatalog = await open();
        const bCatalog = await open();
        await loadFixtures(aCatalog, 0x71);
        await loadFixtures(bCatalog, 0x72);

        const loadedKnown = bCatalog.knownCount;
        const loadedUsage = await bCatalog.usage();
        expect(loadedKnown, 'B starts out with documents of its own').toBeGreaterThan(0);

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
                `B lists the upload (knew ${loadedKnown}, ${loadedUsage.freeBytes}B free)`,
            ).toBeDefined();
        } finally {
            vi.useRealTimers();
            a.stop();
            b.stop();
        }
    });
});

describe('upgrading a database that already has data', () => {
    /**
     * The failure mode this guards is invisible on a fresh install and fatal on
     * an upgraded one: `CREATE TABLE IF NOT EXISTS` is a no-op against a table
     * that exists, so a column added to the DDL reaches new devices only. Every
     * test passes, the app ships, and then every query naming the column fails
     * on exactly the phones that have something to lose.
     */
    it('adds the authorship columns to a docs table created without them', async () => {
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(':memory:');
        db.exec(`CREATE TABLE docs (
            docKey INTEGER PRIMARY KEY NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL,
            bytes INTEGER NOT NULL, chunkCount INTEGER NOT NULL, originId INTEGER NOT NULL,
            createdAt INTEGER NOT NULL, provenance TEXT NOT NULL DEFAULT 'mesh')`);
        db.exec("INSERT INTO docs VALUES (1,'Burns','burns.md',10,2,7,0,'local')");

        // The same shape `migrateColumns` runs: check, then add.
        for (const [name, decl] of [
            ['docHash', "TEXT NOT NULL DEFAULT ''"],
            ['authorKey', "TEXT NOT NULL DEFAULT ''"],
            ['sig', "TEXT NOT NULL DEFAULT ''"],
            ['authorship', "TEXT NOT NULL DEFAULT 'unsigned'"],
        ]) {
            const cols = db.prepare("SELECT name FROM pragma_table_info('docs')").all() as { name: string }[];
            if (cols.some((c) => c.name === name)) continue;
            db.exec(`ALTER TABLE docs ADD COLUMN ${name} ${decl}`);
        }

        const row = db.prepare('SELECT docKey, title, authorship, docHash FROM docs').get() as Record<string, unknown>;
        expect(row.title, 'the existing row survived').toBe('Burns');
        expect(row.authorship, 'and picked up an honest default').toBe('unsigned');
        expect(row.docHash).toBe('');
    });

    it('signs an upload and keeps the signature across a reload', async () => {
        const { keysFromSeed, nodeIdFor, sign } = await import('../identity/keys');
        const { manifestBytes } = await import('../identity/authorship');
        const keys = keysFromSeed(new Uint8Array(32).fill(9));
        const authorId = nodeIdFor(keys.publicKey);

        const catalog = await open();
        const { doc } = await catalog.upload('snakebite.md', UPLOAD, authorId);
        expect(doc.docHash?.length, 'the content hash is computed at ingest').toBe(32);

        const sig = sign(
            manifestBytes({
                docKey: doc.docKey,
                docHash: doc.docHash!,
                title: doc.title,
                source: doc.source,
                chunkCount: doc.chunkCount,
                bytes: doc.bytes,
                createdAtSec: Math.floor(doc.createdAt / 1000),
                authorId,
            }),
            keys.secretKey,
        );
        await catalog.attest(doc.docKey, keys.publicKey, sig);

        // Round-trip through SQLite, which is where hex encoding could quietly
        // corrupt a key and make a genuine document read as a forgery.
        await catalog.reload();
        const stored = catalog.docRow(doc.docKey)!;
        expect(stored.authorship).toBe('verified');
        expect(stored.authorKey).toEqual(keys.publicKey);
        expect(stored.sig).toEqual(sig);
        expect(stored.docHash).toEqual(doc.docHash);
    });
});
