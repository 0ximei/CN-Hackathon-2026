import type { PeerState } from '../../mesh/MeshNode';

/**
 * Route geometry for the topology view.
 *
 * Split out of `MeshGraph` because it is arithmetic and nothing else — no
 * React, no `react-native` — which is the line this project draws for what can
 * be tested off a phone. `stopsAlong` in particular has a hard requirement it
 * cannot state in its type: `Animated.interpolate` throws on an input range
 * that is not strictly increasing, and two nodes landing on the same point is a
 * thing that happens on a small board.
 */

/**
 * The board's own dimensions, which have to agree with `styles.graphNode`.
 *
 * A node is not a disc, it is a disc with two lines of type under it, and the
 * ring used to be sized as though it were: radius `min(w, h) * 0.44` against a
 * half-height that only had about 108px of room once the labels were counted.
 * Every node near the bottom of the ring had its name clipped by the edge of
 * the board and every node near the sides lost half its label, which is what
 * made a working graph look broken.
 */
/** Disc radii, which set how much room a node needs above and below its point. */
export const SELF_R = 26;
export const PEER_R = 20;
/** `graphNode` is 92 wide and centred on the point. */
export const HALF_LABEL_W = 46;
/** marginTop 3 + label lineHeight 14 + sub lineHeight 13, all below the disc. */
export const LABEL_H = 30;
const BASE_HEIGHT = 300;
/** Past a handful of peers the ring needs room rather than tighter packing. */
const CROWD_FROM = 5;
const HEIGHT_PER_EXTRA = 24;
const MAX_HEIGHT = 460;

export interface Point {
    x: number;
    y: number;
}

/** One segment of a route. `known` is false where it stands in for hops we cannot see. */
export interface Segment {
    key: string;
    from: Point;
    to: Point;
    known: boolean;
}

export function pathLength(points: Point[]): number {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    return total;
}

/**
 * Where each corner falls as a fraction of the whole route.
 *
 * `Animated.interpolate` requires a strictly increasing input range, so a
 * zero-length segment — two nodes that happen to land on the same point — would
 * throw rather than degrade. Callers drop empty routes before they get here;
 * this nudges any remaining duplicate rather than risking it.
 */
export function stopsAlong(points: Point[]): number[] {
    const total = pathLength(points) || 1;
    const stops: number[] = [0];
    let run = 0;
    for (let i = 1; i < points.length; i++) {
        run += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
        stops.push(Math.max(run / total, stops[i - 1] + 1e-4));
    }
    return stops;
}

/** The first `fraction` of a route, ending wherever along it that lands. */
export function cutPath(points: Point[], fraction: number): Point[] {
    const target = pathLength(points) * fraction;
    const out: Point[] = [points[0]];
    let run = 0;
    for (let i = 1; i < points.length; i++) {
        const seg = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
        if (run + seg >= target) {
            const k = seg === 0 ? 0 : (target - run) / seg;
            out.push({
                x: points[i - 1].x + (points[i].x - points[i - 1].x) * k,
                y: points[i - 1].y + (points[i].y - points[i - 1].y) * k,
            });
            return out;
        }
        run += seg;
        out.push(points[i]);
    }
    return out;
}

export interface Layout {
    /** Grows with the mesh: a crowded ring needs room, not tighter packing. */
    height: number;
    self: Point;
    nodes: { peer: PeerState; at: Point }[];
    positions: Map<number, Point>;
    /** Every link to draw, once — a shared relay leg is not drawn twice. */
    segments: Segment[];
    /** Node id -> the corners of the route from this node to it. */
    routes: Map<number, Point[]>;
    directIds: number[];
}

/**
 * Deterministic ring layout, arranged around the routes rather than the ids.
 *
 * Direct neighbours sit on an inner ring in id order, so a given phone lands in
 * the same place on every launch of the demo. Anything further out sits on an
 * outer ring *beside the relay it is reached through*, which is what makes the
 * path readable: a chain of three nodes looks like a chain. Sorting the outer
 * ring by id instead — which is what this did first — regularly put a peer on
 * the far side of the board from the only node that could reach it.
 *
 * The rings are ellipses rather than circles, and they are sized from the space
 * a *labelled* node actually occupies rather than from a fraction of the board.
 * A phone screen is taller than the board is and the board is wider than it is
 * tall; one radius for both axes wasted the width and overran the height at the
 * same time.
 *
 * Shape comes from `via`, never from `hops`. They can disagree — the hop count
 * on a peer record is whatever its last beacon travelled, while `via` is the
 * router's own next hop — and when they did, a neighbour would be drawn bent
 * through a relay it does not need.
 */
export function computeLayout(width: number, peers: PeerState[]): Layout {
    const height = Math.min(
        MAX_HEIGHT,
        BASE_HEIGHT + Math.max(0, peers.length - CROWD_FROM) * HEIGHT_PER_EXTRA,
    );

    // Centred in the band a node can occupy, not in the board: the label hangs
    // below the disc, so the usable box is short at the bottom and centring on
    // the board would give the lower half of the ring less room than the upper.
    const self = { x: width / 2, y: (height - LABEL_H) / 2 };
    const rx = Math.max(40, width / 2 - HALF_LABEL_W);
    const ry = Math.max(30, self.y - PEER_R);

    const positions = new Map<number, Point>();
    const angles = new Map<number, number>();

    const ordered = [...peers].sort((a, b) => a.nodeId - b.nodeId);
    // All three states of `via`, and they lay out differently: a neighbour, a
    // peer behind a relay, and a peer the router has no route to at all.
    const direct = ordered.filter((p) => p.via === p.nodeId);
    const distant = ordered.filter((p) => p.via !== p.nodeId && p.via !== 0);
    const stranded = ordered.filter((p) => p.via === 0);

    const inner = distant.length || stranded.length ? 0.56 : 0.94;
    const place = (peer: PeerState, angle: number, scale: number) => {
        angles.set(peer.nodeId, angle);
        positions.set(peer.nodeId, {
            x: self.x + Math.cos(angle) * rx * scale,
            y: self.y + Math.sin(angle) * ry * scale,
        });
    };

    // Start at the top and go round. The half-step offset keeps a lone peer off
    // the vertical axis, where its label would sit on the self node's.
    const slot = (2 * Math.PI) / Math.max(direct.length, 1);
    direct.forEach((peer, i) => place(peer, -Math.PI / 2 + (i + 0.5) * slot, inner));

    // Grouped by relay so siblings fan out around it instead of stacking, and
    // walked nearest-first: on a chain of four, the three-hop node hangs off a
    // two-hop node, so the relay has to be on the board before anything can be
    // placed beside it. Grouping in id order — which is what this did first —
    // put that at the mercy of which phone happened to have the lower id.
    const byRelay = new Map<number, PeerState[]>();
    for (const peer of [...distant].sort((a, b) => a.hops - b.hops)) {
        const group = byRelay.get(peer.via);
        if (group) group.push(peer);
        else byRelay.set(peer.via, [peer]);
    }

    // Orphans are peers whose relay is not on the board at all, counted from the
    // peer list rather than from what has been placed, so the spread does not
    // depend on where in the walk one turns up. They share the outer ring with
    // the stranded, which is where anything this node cannot draw a path to
    // ends up.
    const onBoard = new Set(ordered.map((p) => p.nodeId));
    const loose = distant.filter((p) => !onBoard.has(p.via)).length + stranded.length;
    let orphan = 0;
    const placeLoose = (peer: PeerState) =>
        place(peer, -Math.PI / 2 + ((orphan++ + 0.5) * 2 * Math.PI) / Math.max(loose, 1), 1);

    for (const [relay, group] of byRelay) {
        const base = angles.get(relay);
        if (base === undefined) {
            for (const peer of group) placeLoose(peer);
            continue;
        }
        // Siblings fan around the relay's bearing, but never wider than the
        // slot the relay itself occupies — spilling past it puts a peer nearer
        // to a relay that cannot reach it than to the one that can.
        const spread = Math.min(0.42, (slot * 0.8) / Math.max(group.length - 1, 1));
        group.forEach((peer, i) => place(peer, base + (i - (group.length - 1) / 2) * spread, 1));
    }
    for (const peer of stranded) placeLoose(peer);

    // Routes, then the segments they imply. Keyed by the pair so a relay leg
    // shared by three distant peers is one line rather than three stacked.
    const routes = new Map<number, Point[]>();
    const segments: Segment[] = [];
    const drawn = new Set<string>();

    const addSegment = (key: string, from: Point, to: Point, known: boolean) => {
        if (drawn.has(key)) return;
        drawn.add(key);
        segments.push({ key, from, to, known });
    };

    for (const peer of ordered) {
        const at = positions.get(peer.nodeId);
        if (!at) continue;

        // No route: no line. The node stays on the board because this phone has
        // heard it, and nothing joins it to anything because nothing can reach
        // it — which is a picture the old code could not draw at all.
        if (peer.via === 0) continue;

        if (peer.via === peer.nodeId) {
            routes.set(peer.nodeId, [self, at]);
            addSegment(`self-${peer.nodeId}`, self, at, true);
            continue;
        }

        const relay = positions.get(peer.via);
        if (!relay) {
            // Reachable through someone this node cannot place. Still one line,
            // but a faint one: the route exists, the shape of it is unknown.
            routes.set(peer.nodeId, [self, at]);
            addSegment(`self-${peer.nodeId}`, self, at, false);
            continue;
        }

        routes.set(peer.nodeId, [self, relay, at]);
        addSegment(`self-${peer.via}`, self, relay, true);
        // Exactly two hops means the far leg is one real link the relay holds.
        // Further than that and it stands in for hops this node cannot see.
        addSegment(`${peer.via}-${peer.nodeId}`, relay, at, peer.hops === 2);
    }

    return {
        height,
        self,
        nodes: ordered.flatMap((peer) => {
            const at = positions.get(peer.nodeId);
            return at ? [{ peer, at }] : [];
        }),
        positions,
        segments,
        routes,
        directIds: direct.map((p) => p.nodeId),
    };
}
