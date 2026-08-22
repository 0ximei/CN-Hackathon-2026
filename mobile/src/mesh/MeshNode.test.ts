import { afterEach, describe, expect, it, vi } from 'vitest';

import { MockTransport } from '@core/protocol/testHarness';
import type { Identity } from '@core/lib/ids';

import { MeshNode, type MeshHit } from './MeshNode';
import { MemoryCatalog } from '../storage/MemoryCatalog';
import { keysFromSeed, nodeIdFor, sign } from '../identity/keys';

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

/**
 * A node whose id really is the hash of its key, which is what identity
 * verification is about — anything else could not pass its own check.
 */
function buildSigned(seedByte: number, name: string): Built & { publicKey: Uint8Array } {
    const keys = keysFromSeed(new Uint8Array(32).fill(seedByte));
    const id = nodeIdFor(keys.publicKey);
    const transport = new MockTransport(`link-${id}`);
    const catalog = new MemoryCatalog();
    const node = new MeshNode(identity(id, name), transport, catalog, {
        publicKey: keys.publicKey,
        sign: (message) => sign(message, keys.secretKey),
    });
    return { node, transport, catalog, publicKey: keys.publicKey };
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
        expect(hit!.storedHere).toBe(true);
    });

    /**
     * A node with nothing relevant stays silent.
     *
     * Without the floor this returns the least-irrelevant passage it holds and
     * the answer layer cites it — confident frostbite advice for a burn
     * question. On this corpus that is the worst failure available.
     */
    it('says nothing rather than returning its least-irrelevant passage', async () => {
        const solo = build(0x12, 'Quiet');
        solo.catalog.add(404, 'Water', BOILING);
        await startAll(solo.node);

        const state = await solo.node.search('best recipe for sourdough bread');
        expect(state.hits).toHaveLength(0);
    });

    /**
     * Snippets ride inside RESULT packets; bodies do not. A remote hit
     * therefore arrives truncated, and opening it costs a DOC_REQ round trip.
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
});

describe('two-tier storage', () => {
    /**
     * The design's central claim, as an assertion.
     *
     * A node that knows a passage but does not hold it still answers the query
     * — the embedding lives in the metadata tier — and the row it returns names
     * somebody else as the holder rather than pretending to have the text.
     */
    it('answers from metadata it holds no body for, and names a holder', async () => {
        const a = build(0x41, 'Asker');
        const b = build(0x42, 'Knower');
        const c = build(0x43, 'Holder');

        // B knows about the passage and has dropped the body; C has it.
        b.catalog.add(606, 'Bleeding', TOURNIQUET);
        b.catalog.dropBody(606);
        c.catalog.add(606, 'Bleeding', TOURNIQUET);

        a.transport.link(b.transport);
        b.transport.link(c.transport);
        await startAll(a.node, b.node, c.node);

        expect(b.catalog.knownCount).toBe(1);
        expect(b.catalog.storedCount, 'B knows it without storing it').toBe(0);

        const state = await a.node.search('how tight should a tourniquet be');
        const hit = state.hits.find((h) => h.docId === 606);

        expect(hit, 'the metadata-only node still answered').toBeDefined();
        // And the text is retrievable, because the mesh routed the fetch to a
        // node that actually holds it.
        expect(await a.node.fetchFullText(hit!)).toBe(TOURNIQUET);
    });

    /**
     * The storage-budget demo, end to end.
     *
     * Three nodes, not two, and that is a property of the policy rather than of
     * the test: `MIN_BODY_REPLICAS` is 2, so a node on a two-node mesh holding
     * one of the only two copies is not allowed to shed it however far over
     * budget it is. Storage pressure loses to availability. It takes a third
     * node before the first one has anything it can safely drop.
     */
    it('sheds bodies but keeps metadata when the budget shrinks', async () => {
        vi.useFakeTimers();
        const a = build(0x51, 'Roomy');
        const b = build(0x52, 'Backup');
        const c = build(0x53, 'Spare');
        a.transport.link(b.transport);
        a.transport.link(c.transport);
        await startAll(a.node, b.node, c.node);
        // Every direction has to have beaconed before any of them can place a
        // replica: a node that does not know a peer exists cannot rank it as a
        // candidate, let alone pull from it.
        await vi.advanceTimersByTimeAsync(3_100);

        // Long enough that its bodies dominate the budget. A one-sentence
        // document is smaller than its own metadata, so shrinking the budget
        // would leave the node under pressure with nothing worth shedding.
        const paragraph =
            'Cool a burn under running water for about twenty minutes to limit tissue damage. ' +
            'Do not use ice, which causes further injury to the tissue underneath. ' +
            'Cover the burn loosely with clean non-fluffy material once it has been cooled. ';
        await a.node.upload('burns.md', `# Burns\n\n${paragraph.repeat(40)}`);
        const knownBefore = a.catalog.knownCount;
        expect(a.catalog.storedCount).toBeGreaterThan(0);

        for (let i = 0; i < 8; i++) {
            await a.node.replicator.reconcile();
            await b.node.replicator.reconcile();
            await c.node.replicator.reconcile();
        }
        expect(b.catalog.storedCount, 'B replicated the body').toBeGreaterThan(0);
        expect(c.catalog.storedCount, 'C replicated the body').toBeGreaterThan(0);

        await a.node.setBudget(4 * 1024);
        for (let i = 0; i < 8; i++) await a.node.replicator.reconcile();

        expect(a.catalog.knownCount, 'metadata survives').toBe(knownBefore);
        expect(a.catalog.storedCount, 'bodies do not').toBe(0);

        // The collection window polls on real timer semantics; switch back so
        // the search can actually resolve.
        vi.useRealTimers();
        // Still searchable from a node that stores nothing at all.
        const state = await a.node.search('cool a burn under running water');
        expect(state.hits.length).toBeGreaterThan(0);
        expect(state.hits.every((h) => !h.storedHere), 'answered from metadata alone').toBe(true);
    });

    /**
     * Never drop the last live copy. This outranks storage pressure, eviction
     * policy and the placement ranking itself.
     */
    it('keeps the only copy of a body even when over budget', async () => {
        const solo = build(0x53, 'Only');
        await startAll(solo.node);

        await solo.node.upload(
            'water.md',
            `# Water\n\n${BOILING} Boiling kills every pathogen that matters at sea level.`,
        );
        const stored = solo.catalog.storedCount;
        expect(stored).toBeGreaterThan(0);

        await solo.node.setBudget(1024);
        for (let i = 0; i < 4; i++) await solo.node.replicator.reconcile();

        expect(solo.catalog.storedCount, 'nothing was evicted — there is nowhere else').toBe(stored);
    });
});

describe('replication', () => {
    /**
     * An upload does not just sit in the uploader's catalog. Its metadata
     * gossips out via ANNOUNCE, and a peer that ranks for a chunk pulls the
     * body in on its own, unprompted, without ever having searched for it.
     */
    it('replicates an upload to a linked peer', async () => {
        vi.useFakeTimers();
        const a = build(0x61, 'Uploader');
        const b = build(0x62, 'Neighbour');
        a.transport.link(b.transport);
        await startAll(a.node, b.node);
        await vi.advanceTimersByTimeAsync(3_100);

        await a.node.upload(
            'burns.md',
            '# Burns\n\nCool a burn under running water for about twenty minutes to limit tissue damage.',
        );

        // Metadata arrives first, on the ANNOUNCE the upload sent.
        expect(b.catalog.knownCount).toBeGreaterThan(0);
        expect(b.catalog.storedCount, 'the body is a separate decision').toBe(0);

        // Bodies follow, once the replicator has run and decided.
        for (let i = 0; i < 4; i++) {
            await b.node.replicator.reconcile();
            await a.node.replicator.reconcile();
        }
        expect(b.catalog.storedCount, 'the body was pulled by policy').toBeGreaterThan(0);

        vi.useRealTimers();
        const state = await b.node.search('cool a burn under running water');
        const hit = state.hits.find((h) => h.title === 'Burns');
        expect(hit, 'the pulled passage is now searchable locally on Bravo').toBeDefined();
        expect(hit!.local).toBe(true);
    });

    /**
     * The bug a real second device hit: node B joins the mesh *after* A already
     * uploaded something. The only chance to catch up is the one-shot
     * CATALOG_REQ/CATALOG_RES exchange triggered by meeting a peer.
     */
    it('syncs an upload to a peer that joins after it happened', async () => {
        vi.useFakeTimers();
        const a = build(0x63, 'Alpha');
        const b = build(0x64, 'LateJoiner');

        await startAll(a.node);
        await a.node.upload(
            'snakebite.md',
            '# Snake Bite\n\nKeep the person still and calm; immobilise the bitten limb and seek antivenom urgently.',
        );

        // B only shows up now — the file was already uploaded before it existed.
        a.transport.link(b.transport);
        await startAll(b.node);

        // A's next periodic beacon is what introduces it to B; that HELLO is
        // what triggers B's one-shot catalog sync request back to A.
        await vi.advanceTimersByTimeAsync(3_100);

        expect(b.catalog.knownCount, 'the pre-existing upload reached the late joiner').toBeGreaterThan(0);

        // search()'s collection window polls with real timer semantics; switch
        // back so it can actually resolve.
        vi.useRealTimers();
        const state = await b.node.search('immobilise a snake bite');
        expect(state.hits.some((h) => h.title === 'Snake Bite')).toBe(true);
    });

    /** Searching counts a hit, which is what earns a chunk extra replicas. */
    it('counts a query against the passages it returned', async () => {
        const solo = build(0x65, 'Counter');
        solo.catalog.add(707, 'Water', BOILING);
        await startAll(solo.node);

        await solo.node.search('how long should I boil water');
        const pop = await solo.catalog.popRows();

        expect(pop.find((p) => p.docId === 707)?.hits).toBe(1);
        expect(pop.every((p) => p.nodeId === 0x65), 'only this node’s own share').toBe(true);
    });
});

describe('identity verification', () => {
    it('verifies a peer that can sign for the id it is using', async () => {
        vi.useFakeTimers();
        const a = buildSigned(0x11, 'Alpha');
        const b = buildSigned(0x22, 'Bravo');
        a.transport.link(b.transport);
        await startAll(a.node, b.node);

        await vi.advanceTimersByTimeAsync(200);

        const seen = a.node.identityOf(b.node.identity.id);
        expect(seen?.state).toBe('verified');
        expect(seen?.publicKeyHex).toHaveLength(64);
        expect(seen?.name).toBe('Bravo');
    });

    /**
     * The id is a hash of the key, so a node using an id that is not its key's
     * hash is using an id it has no claim to — however valid the signature is.
     */
    it('rejects a node whose id does not match the key that signed', async () => {
        vi.useFakeTimers();
        const a = buildSigned(0x33, 'Alpha');

        // An impostor: real key, real signature, id that is not its hash.
        const keys = keysFromSeed(new Uint8Array(32).fill(0x44));
        const transport = new MockTransport('link-impostor');
        const impostor = new MeshNode(
            identity(0x1234, 'Impostor'),
            transport,
            new MemoryCatalog(),
            { publicKey: keys.publicKey, sign: (m) => sign(m, keys.secretKey) },
        );
        a.transport.link(transport);
        await startAll(a.node, impostor);

        await vi.advanceTimersByTimeAsync(200);

        const seen = a.node.identityOf(0x1234);
        expect(seen?.state).toBe('failed');
        expect(seen?.detail).toMatch(/does not match/);
    });

    /** A node with no credentials stays unverified rather than failing. */
    it('leaves a node that cannot sign unverified, not accused', async () => {
        vi.useFakeTimers();
        const a = buildSigned(0x55, 'Alpha');
        const mute = build(0x66, 'Mute');
        a.transport.link(mute.transport);
        await startAll(a.node, mute.node);

        await vi.advanceTimersByTimeAsync(200);
        expect(a.node.identityOf(0x66)?.state).toBe('pending');

        // The challenge times out and settles back to "unverified", which is
        // what it is — not "failed", which would be an accusation.
        await vi.advanceTimersByTimeAsync(11_000);
        expect(a.node.identityOf(0x66)?.state).toBe('unknown');
    });

    /**
     * `verified` is what the radio can establish; `trusted` needs a person, and
     * software never awards it to itself.
     */
    it('only accepts an in-person confirmation for an already-verified peer', async () => {
        vi.useFakeTimers();
        const a = buildSigned(0x77, 'Alpha');
        const b = buildSigned(0x88, 'Bravo');
        a.transport.link(b.transport);
        await startAll(a.node, b.node);
        await vi.advanceTimersByTimeAsync(200);

        vi.useRealTimers();
        await a.node.markTrusted(b.node.identity.id);
        expect(a.node.identityOf(b.node.identity.id)?.state).toBe('trusted');

        await a.node.clearTrust(b.node.identity.id);
        expect(a.node.identityOf(b.node.identity.id)?.state).toBe('verified');
    });
});
