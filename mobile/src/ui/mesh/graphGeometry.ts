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
 * A node is not a disc, it is a disc with two lines of type under it, so it
 * needs `PEER_R` of room above its point and `PEER_R + LABEL_H` below. Two of
 * them overlap when their boxes do: closer than a node width apart across, and
 * closer than a node height apart down.
 */
/** Disc radii, which set how much room a node needs above and below its point. */
export const SELF_R = 26;
export const PEER_R = 20;
/** marginTop 3 + label lineHeight 14 + sub lineHeight 13, all below the disc. */
export const LABEL_H = 30;
/** Widest a node's label box gets. Narrower when the board is crowded. */
export const NODE_W_MAX = 92;
/** Narrower than this and a name is not worth printing. Forces another band. */
export const NODE_W_MIN = 56;
/** Clear space between one band of nodes and the next. */
const BAND_PAD = 12;
/** Above this node's disc, when something hangs below it. */
const TOP_PAD = 4;
/** Short graphs still want some presence on the page. */
const MIN_HEIGHT = 200;

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
    /** Grows with the mesh: depth costs a band, a crowded level costs another. */
    height: number;
    /** Label box width, narrowed from `NODE_W_MAX` when a band is crowded. */
    nodeW: number;
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
 * Layered by hop count: this node on top, its neighbours under it, everything
 * they relay for under them.
 *
 * This was a ring for a long time and the ring could not be made to work. A
 * labelled node needs 92px across and 70px down, so two levels of them need
 * 184px of horizontal radius either side of centre; a portrait phone gives
 * about 129px. Every relay overlapped the peer behind it at every bearing, and
 * the inner ring overlapped the node at the centre — not a tuning problem, an
 * arithmetic one, and no radius fixes it.
 *
 * Bands fix it because the board can grow downwards and cannot grow sideways.
 * They also happen to be the right picture: from this node's point of view the
 * route table *is* a tree — every destination has exactly one next hop — so
 * depth on the screen is distance through the mesh, which is the thing this
 * view exists to show.
 *
 * A row wider than the board splits into more bands rather than packing tighter,
 * and the label box narrows to the widest band's slot so names truncate instead
 * of colliding. Order within a band follows the parent's, so relay legs fan out
 * locally instead of crossing the board.
 *
 * Shape comes from `via`, never from `hops`. They can disagree — the hop count
 * on a peer record is whatever its last beacon travelled, while `via` is the
 * router's own next hop — and when they did, a neighbour was drawn hanging off
 * a relay it does not need.
 */
export function computeLayout(width: number, peers: PeerState[]): Layout {
    const ordered = [...peers].sort((a, b) => a.nodeId - b.nodeId);
    // All three states of `via`: a neighbour, a peer behind one, and a peer the
    // router has no route to at all.
    const direct = ordered.filter((p) => p.via === p.nodeId);
    const behind = ordered.filter((p) => p.via !== p.nodeId && p.via !== 0);
    const stranded = ordered.filter((p) => p.via === 0);

    // One level per hop count, so a three-hop peer sits below a two-hop one even
    // though both hang off a neighbour — the next hop is always a direct link,
    // so the parent is always on the first level whatever the distance.
    const levels = new Map<number, PeerState[]>();
    const at = (level: number) => {
        const row = levels.get(level);
        if (row) return row;
        const made: PeerState[] = [];
        levels.set(level, made);
        return made;
    };
    at(1).push(...direct);
    for (const peer of behind) at(Math.max(2, peer.hops)).push(peer);
    // Unreachable peers go under everything, joined to nothing.
    if (stranded.length) at(Math.max(1, ...levels.keys()) + 1).push(...stranded);

    // Bands: a level too wide for the board becomes several. `perBand` is how
    // many nodes fit before a name stops being worth printing.
    const perBand = Math.max(1, Math.floor(width / NODE_W_MIN));
    const bands: PeerState[][] = [];
    const order = new Map<number, number>();
    for (const level of [...levels.keys()].sort((a, b) => a - b)) {
        // Children follow their parent's position, so legs stay local.
        const row = [...levels.get(level)!].sort(
            (a, b) => (order.get(a.via) ?? 0) - (order.get(b.via) ?? 0) || a.nodeId - b.nodeId,
        );
        for (let i = 0; i < row.length; i += perBand) {
            const band = row.slice(i, i + perBand);
            band.forEach((peer, j) => order.set(peer.nodeId, bands.length * 1000 + j));
            bands.push(band);
        }
    }

    // The slot the widest band has to live in decides the label width for all of
    // them, so nodes are one size and no band is tighter than its own boxes.
    const widest = Math.max(1, ...bands.map((b) => b.length));
    const nodeW = Math.max(NODE_W_MIN, Math.min(NODE_W_MAX, width / widest));

    // Alone on the board, this node is the whole picture and belongs in the
    // middle of it. Sitting at the top is only right when it is the root of
    // something: with no peers there is nothing below to be the root of, and a
    // node pinned to the top edge of an otherwise empty box reads as a layout
    // that has failed rather than as a mesh of one.
    const alone = bands.length === 0;
    const selfBox = SELF_R * 2 + LABEL_H;

    const positions = new Map<number, Point>();
    const self = {
        x: width / 2,
        y: alone ? (MIN_HEIGHT - selfBox) / 2 + SELF_R : SELF_R + TOP_PAD,
    };
    let y = self.y + SELF_R + LABEL_H + BAND_PAD + PEER_R;

    for (const band of bands) {
        const slot = width / band.length;
        band.forEach((peer, i) => positions.set(peer.nodeId, { x: slot * (i + 0.5), y }));
        y += PEER_R + LABEL_H + BAND_PAD + PEER_R;
    }
    // `y` has run one band past the last, so take the pad and half-band back.
    const height = alone ? MIN_HEIGHT : Math.max(MIN_HEIGHT, y - BAND_PAD - PEER_R + 6);

    // Routes, then the segments they imply. Keyed by the pair so a relay leg
    // shared by three peers behind it is one line rather than three stacked.
    const routes = new Map<number, Point[]>();
    const segments: Segment[] = [];
    const drawn = new Set<string>();

    const addSegment = (key: string, from: Point, to: Point, known: boolean) => {
        if (drawn.has(key)) return;
        drawn.add(key);
        segments.push({ key, from, to, known });
    };

    for (const peer of ordered) {
        const point = positions.get(peer.nodeId);
        if (!point) continue;

        // No route: no line. The node stays on the board because this phone has
        // heard it, and nothing joins it to anything because nothing can reach
        // it — a picture the old code could not draw at all.
        if (peer.via === 0) continue;

        if (peer.via === peer.nodeId) {
            routes.set(peer.nodeId, [self, point]);
            addSegment(`self-${peer.nodeId}`, self, point, true);
            continue;
        }

        const relay = positions.get(peer.via);
        if (!relay) {
            // Reachable through someone this node cannot place. Still one line,
            // but a faint one: the route exists, the shape of it is unknown.
            routes.set(peer.nodeId, [self, point]);
            addSegment(`self-${peer.nodeId}`, self, point, false);
            continue;
        }

        routes.set(peer.nodeId, [self, relay, point]);
        addSegment(`self-${peer.via}`, self, relay, true);
        // Exactly two hops means the far leg is one real link the relay holds.
        // Further than that and it stands in for hops this node cannot see.
        addSegment(`${peer.via}-${peer.nodeId}`, relay, point, peer.hops === 2);
    }

    return {
        height,
        nodeW,
        self,
        nodes: ordered.flatMap((peer) => {
            const point = positions.get(peer.nodeId);
            return point ? [{ peer, at: point }] : [];
        }),
        positions,
        segments,
        routes,
        directIds: direct.map((p) => p.nodeId),
    };
}
