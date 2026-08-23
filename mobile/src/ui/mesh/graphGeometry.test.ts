import { describe, expect, it } from 'vitest';

import type { PeerState } from '../../mesh/MeshNode';

import {
    LABEL_H,
    NODE_W_MIN,
    PEER_R,
    SELF_R,
    computeLayout,
    cutPath,
    pathLength,
    stopsAlong,
    type Point,
} from './graphGeometry';

/** Only the four fields the layout reads; the rest never reaches it. */
function peer(nodeId: number, hops: number, via: number): PeerState {
    return {
        nodeId,
        name: `n${nodeId}`,
        known: 0,
        stored: 0,
        documents: 0,
        freeBytes: 0,
        reliability: 1,
        lastSeen: 0,
        hops,
        via,
        trust: 'unknown',
        verified: false,
    };
}

/** Screen widths the board actually gets, small phone through tablet. */
const WIDTHS = [240, 327, 351, 387, 736];

/** Shapes worth holding to: a pair, a chain, a hub, and a crowd. */
const MESHES: PeerState[][] = [
    [peer(1, 1, 1)],
    [peer(1, 1, 1), peer(2, 1, 2)],
    [peer(1, 1, 1), peer(2, 2, 1), peer(3, 2, 1)],
    // A chain: one direct, one behind it, one further still.
    [peer(1, 1, 1), peer(2, 2, 1), peer(3, 4, 1)],
    // A peer nothing can route to, alongside one that can be reached.
    [peer(1, 1, 1), peer(2, 3, 0)],
    // More neighbours than a band holds, which is what forces a second one.
    Array.from({ length: 8 }, (_, i) => peer(i + 1, 1, i + 1)),
    // A hub relaying for a crowd.
    [peer(1, 1, 1), ...Array.from({ length: 7 }, (_, i) => peer(i + 2, 2, 1))],
];

const p = (x: number, y: number): Point => ({ x, y });

/** Self at the origin, a relay 30 to the right, a two-hop node 40 beyond it. */
const TWO_HOP: Point[] = [p(0, 0), p(30, 0), p(70, 0)];

describe('graph geometry', () => {
    it('measures a route corner to corner, not end to end', () => {
        // The distinction only shows up on a bent path, which is the whole
        // point of drawing one: a right-angled route is longer than the
        // straight line a direct link would have been.
        expect(pathLength([p(0, 0), p(30, 0), p(30, 40)])).toBe(70);
        expect(pathLength([p(0, 0), p(30, 40)])).toBe(50);
    });

    /**
     * The stops place each corner by distance, not by index.
     *
     * Spacing them evenly instead would make the packet cross a short leg and a
     * long leg in the same time — it would visibly slow down over the far half
     * of an asymmetric route, which reads as the relay being slow rather than
     * as the leg being longer.
     */
    it('spaces corners by distance travelled', () => {
        expect(stopsAlong(TWO_HOP)).toEqual([0, 30 / 70, 1]);
    });

    /**
     * `Animated.interpolate` throws on an input range that is not strictly
     * increasing, and coincident nodes are not hypothetical — a peer whose
     * relay sits at the same bearing lands on top of it on a narrow board.
     */
    it('never emits a flat or backwards input range', () => {
        for (const route of [
            [p(10, 10), p(10, 10), p(50, 10)],
            [p(0, 0), p(0, 0), p(0, 0)],
            [p(5, 5), p(5, 5)],
        ]) {
            const stops = stopsAlong(route);
            expect(stops).toHaveLength(route.length);
            expect(stops[0]).toBe(0);
            for (let i = 1; i < stops.length; i++) {
                expect(stops[i], `stop ${i} of ${JSON.stringify(stops)}`).toBeGreaterThan(
                    stops[i - 1],
                );
            }
        }
    });

    /**
     * A dropped packet dies partway along the route it was actually on.
     *
     * Scaling the endpoint instead — which is what this did while every route
     * was a single straight line — puts the packet in open space beside a
     * bent path rather than on the leg it failed on.
     */
    it('cuts a dropped packet short along the route', () => {
        const cut = cutPath(TWO_HOP, 0.5);
        // Half of 70 is 35, which is five past the corner.
        expect(cut).toEqual([p(0, 0), p(30, 0), p(35, 0)]);
        expect(pathLength(cut)).toBeCloseTo(35);
    });

    it('keeps a cut inside the first leg when it falls there', () => {
        const cut = cutPath(TWO_HOP, 0.2);
        expect(cut).toEqual([p(0, 0), p(14, 0)]);
    });

    it('leaves a whole route whole', () => {
        expect(pathLength(cutPath(TWO_HOP, 1))).toBeCloseTo(70);
    });

});

describe('graph layout', () => {
    /**
     * The bug that made a working graph look broken.
     *
     * A node is not a disc, it is a disc with two lines of type under it, and
     * the ring was sized as though it were — radius `min(w, h) * 0.44` against
     * a half-height with about 108px of usable room once the labels were
     * counted. Names were clipped by the bottom of the board and cut in half at
     * the sides. Nothing about that is visible from a type or a render test, so
     * it is asserted here: every label box, on every screen width, inside the
     * board.
     */
    it('keeps every node label inside the board', () => {
        for (const width of WIDTHS) {
            for (const peers of MESHES) {
                const layout = computeLayout(width, peers);
                const where = `${peers.length} peers at ${width}px`;
                const half = layout.nodeW / 2;

                for (const { peer: p, at } of layout.nodes) {
                    expect(at.x - half, `${p.name} left, ${where}`).toBeGreaterThanOrEqual(0);
                    expect(at.x + half, `${p.name} right, ${where}`).toBeLessThanOrEqual(width);
                    expect(at.y - PEER_R, `${p.name} top, ${where}`).toBeGreaterThanOrEqual(0);
                    expect(
                        at.y + PEER_R + LABEL_H,
                        `${p.name} bottom, ${where}`,
                    ).toBeLessThanOrEqual(layout.height);
                }

                // The self node is bigger and carries a label of its own.
                expect(layout.self.y - SELF_R, `self top, ${where}`).toBeGreaterThanOrEqual(0);
                expect(
                    layout.self.y + SELF_R + LABEL_H,
                    `self bottom, ${where}`,
                ).toBeLessThanOrEqual(layout.height);
            }
        }
    });

    /**
     * The bug that survived the first fix.
     *
     * Fitting inside the board is not the same as fitting beside each other. A
     * two-ring layout put a relay 51px from the peer behind it, against boxes
     * 70px tall, so every chain overlapped at every bearing — and the ring at
     * the centre overlapped the node in the middle of it. That is arithmetic,
     * not tuning: two levels of labelled node need 184px of horizontal radius
     * and a portrait phone has about 129px. Bands are what make it fit, and
     * this is the assertion that says so.
     */
    it('never overlaps two nodes', () => {
        for (const width of WIDTHS) {
            for (const peers of MESHES) {
                const layout = computeLayout(width, peers);
                const where = `${peers.length} peers at ${width}px`;

                // The box a node actually paints: the disc, then its two lines
                // of label under it. Self's disc is the larger one.
                const box = (name: string, at: { x: number; y: number }, r: number) => ({
                    name,
                    left: at.x - layout.nodeW / 2,
                    right: at.x + layout.nodeW / 2,
                    top: at.y - r,
                    bottom: at.y + r + LABEL_H,
                });
                const boxes = [
                    box('self', layout.self, SELF_R),
                    ...layout.nodes.map((n) => box(n.peer.name, n.at, PEER_R)),
                ];

                for (let i = 0; i < boxes.length; i++) {
                    for (let j = i + 1; j < boxes.length; j++) {
                        const a = boxes[i];
                        const b = boxes[j];
                        const hit =
                            a.left < b.right &&
                            b.left < a.right &&
                            a.top < b.bottom &&
                            b.top < a.bottom;
                        expect(hit, `${a.name} and ${b.name} collide, ${where}`).toBe(false);
                    }
                }
            }
        }
    });

    /**
     * A mesh of one is still a picture, and the subject of it goes in the
     * middle.
     *
     * This node sits at the top of the board because things hang below it. With
     * no peers nothing does, and leaving it pinned there put a single disc
     * against the top edge of an otherwise empty box, which reads as a layout
     * that has failed rather than as a phone waiting for company.
     */
    it('centres this node when it is the only one', () => {
        for (const width of WIDTHS) {
            const layout = computeLayout(width, []);
            expect(layout.nodes).toEqual([]);
            expect(layout.segments).toEqual([]);

            // Centred by its painted box, not by its point: the label hangs
            // below the disc, so centring the point leaves it sitting high.
            const top = layout.self.y - SELF_R;
            const bottom = layout.self.y + SELF_R + LABEL_H;
            expect(top, `top margin at ${width}px`).toBeCloseTo(layout.height - bottom, 5);
            expect(layout.self.x).toBeCloseTo(width / 2, 5);
        }
    });

    /** A name needs room to be a name. Another band is better than a sliver. */
    it('never narrows a label past legibility', () => {
        for (const width of WIDTHS) {
            for (const peers of MESHES) {
                expect(computeLayout(width, peers).nodeW).toBeGreaterThanOrEqual(NODE_W_MIN);
            }
        }
    });

    /**
     * Shape follows `via`, never `hops`.
     *
     * The two disagree in practice: a peer record takes its hop count from
     * whichever HELLO arrived, while `via` is the router's own next hop. A
     * neighbour whose relayed beacon won the race to the deduplicator carries
     * `hops: 2` and must still be drawn as the one link it is.
     */
    it('draws a neighbour straight even when its hop count says otherwise', () => {
        const layout = computeLayout(351, [peer(1, 2, 1)]);
        expect(layout.routes.get(1)).toEqual([layout.self, layout.positions.get(1)]);
        expect(layout.segments).toHaveLength(1);
        expect(layout.segments[0].known).toBe(true);
        expect(layout.directIds).toEqual([1]);
    });

    it('bends a two-hop peer through its relay and draws no line to it', () => {
        const relay = peer(1, 1, 1);
        const far = peer(2, 2, 1);
        const layout = computeLayout(351, [relay, far]);

        const relayAt = layout.positions.get(1)!;
        const farAt = layout.positions.get(2)!;
        expect(layout.routes.get(2)).toEqual([layout.self, relayAt, farAt]);

        // Both legs are real links somebody holds, and there is no self -> far.
        expect(layout.segments.map((s) => s.key).sort()).toEqual(['1-2', 'self-1']);
        expect(layout.segments.every((s) => s.known)).toBe(true);
        expect(layout.directIds).toEqual([1]);
    });

    /**
     * Past two hops the far leg stands in for links this node cannot see, which
     * is a different claim from a real link and has to look different.
     */
    it('fades the leg that hides hops it cannot see', () => {
        const layout = computeLayout(351, [peer(1, 1, 1), peer(2, 2, 1), peer(3, 4, 2)]);
        const tail = layout.segments.find((s) => s.key === '2-3');
        expect(tail, 'the leg past the second relay').toBeDefined();
        expect(tail!.known).toBe(false);
    });

    /**
     * `via: 0` is unreachable, and the honest drawing of unreachable is no line
     * at all. Collapsing it into "direct" — which the first version did — drew
     * a radio link to a peer nothing could route to.
     */
    it('draws no edge to a peer it has no route to', () => {
        const layout = computeLayout(351, [peer(1, 1, 1), peer(2, 3, 0)]);
        expect(layout.routes.has(2)).toBe(false);
        expect(layout.segments.map((s) => s.key)).toEqual(['self-1']);
        // Still on the board: this phone has heard it, it just cannot reach it.
        expect(layout.nodes.map((n) => n.peer.nodeId)).toEqual([1, 2]);
    });

    /**
     * A relay leg shared by several peers behind it is one line, not a stack of
     * identical ones drawn on top of each other.
     */
    it('draws a shared relay leg once', () => {
        const layout = computeLayout(351, [peer(1, 1, 1), peer(2, 2, 1), peer(3, 2, 1)]);
        expect(layout.segments.filter((s) => s.key === 'self-1')).toHaveLength(1);
    });

    /** Same phones, same places, every run — the demo is narrated live. */
    it('places a mesh identically on every render', () => {
        const peers = [peer(3, 2, 1), peer(1, 1, 1), peer(2, 2, 1)];
        const once = computeLayout(351, peers);
        const twice = computeLayout(351, [...peers].reverse());
        expect([...twice.positions]).toEqual([...once.positions]);
    });
});
