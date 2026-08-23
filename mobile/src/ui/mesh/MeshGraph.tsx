import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Text, View, useWindowDimensions } from 'react-native';

import type { Identity } from '@core/lib/ids';

import type { ActivityEvent, PeerState } from '../../mesh/MeshNode';
import { useTheme } from '../ThemeProvider';
import { typography } from '../theme';
import { cutPath, pathLength, stopsAlong, type Point } from './graphGeometry';

/**
 * The topology view.
 *
 * This is the organising element of the browser build's page, and its absence
 * was the biggest thing missing here: without it a phone shows a list of peers
 * and a list of log lines, and nothing connects the two. Every dot travelling
 * an edge below is a real packet the router actually sent, and every edge is a
 * link the transport actually reports as up.
 *
 * **Nothing is drawn between two nodes that have no link.** That sounds
 * obvious and it was not true for a long time: a peer two hops away was drawn
 * on a line straight to this node, dimmer than a real link but still a line
 * between two phones that cannot hear each other, and packets to it flew down
 * that line as though they had gone directly. The relay doing the actual work
 * was on screen the whole time with nothing joining it to either end. Edges and
 * packets now both follow the route — self, relay, destination — which is the
 * one thing this view exists to show.
 *
 * Drawn with plain Views rather than SVG. `react-native-svg` would be the
 * obvious tool and would also be a new native dependency — a prebuild and a
 * rebuild on every phone in the room — for a diagram that is a dozen circles
 * and a dozen straight lines. A line is a 1px View rotated about its left edge,
 * which is exact for a straight segment, and the packets are `Animated` values
 * driving a translation, which runs on the UI thread with the native driver
 * instead of re-rendering React sixty times a second.
 *
 * The layout is a deterministic ring rather than a force simulation. On stage
 * you want the same node in the same place every run; a force layout re-settles
 * differently on every render and makes the demo hard to narrate.
 */

const HEIGHT = 300;
const FLIGHT_MS = 700;
const MAX_FLIGHTS = 18;
const SELF_R = 26;
const PEER_R = 20;

interface Flight {
    key: number;
    /** The whole route, corner to corner. Two points for a direct link. */
    points: Point[];
    color: string;
    dropped: boolean;
}

/** One segment of a route. `known` is false where it stands in for hops we cannot see. */
interface Segment {
    key: string;
    from: Point;
    to: Point;
    known: boolean;
}

interface Props {
    identity: Identity;
    /** Passages whose body this node stores — "what do you carry". */
    selfStored: number;
    selfKnown: number;
    peers: PeerState[];
    activity: ActivityEvent[];
    respondedNodeIds: number[];
}

export function MeshGraph({
    identity,
    selfStored,
    selfKnown,
    peers,
    activity,
    respondedNodeIds,
}: Props) {
    const { styles, theme, accent } = useTheme();
    const { width } = useWindowDimensions();
    const boardWidth = Math.max(240, width - 24);

    const layout = useMemo(
        () => computeLayout(boardWidth, peers),
        [boardWidth, peers],
    );

    const [flights, setFlights] = useState<Flight[]>([]);
    const flightKey = useRef(0);
    /** Highest event sequence already drawn. See ActivityEvent.seq. */
    const drawnUpTo = useRef(-1);

    // Turn router events into flights along the edges they actually traversed.
    useEffect(() => {
        // The tabs mount one at a time, so arriving here means up to two hundred
        // events have accumulated while the map was not on screen. Replaying
        // them would animate several minutes of history in one frame; the map
        // shows traffic as it happens, so the backlog is skipped and only what
        // arrives from now on is drawn.
        if (drawnUpTo.current < 0) {
            drawnUpTo.current = activity[activity.length - 1]?.seq ?? 0;
            return;
        }

        const fresh = activity.filter((ev) => ev.seq > drawnUpTo.current);
        if (!fresh.length) return;
        drawnUpTo.current = activity[activity.length - 1]?.seq ?? drawnUpTo.current;

        const added: Flight[] = [];
        const push = (points: Point[], color: string, dropped: boolean) => {
            // A route with no length is a node drawn on top of this one; there
            // is nothing to animate and an interpolation over it would throw.
            if (points.length >= 2 && pathLength(points) > 0) {
                added.push({ key: flightKey.current++, points, color, dropped });
            }
        };

        for (const ev of fresh) {
            if (ev.kind === 'radio' || ev.kind === 'replicated' || ev.kind === 'evicted') continue;
            const color = ev.kind === 'dropped' ? theme.danger : (theme.wire[ev.type] ?? theme.faint);

            if (ev.kind === 'received') {
                // Inbound, so the same route read backwards: a packet from two
                // hops away arrives *through* the relay, and drawing it flying
                // in off the outer ring in a straight line is the same lie the
                // edges used to tell.
                const route = layout.routes.get(ev.srcId);
                if (route) push([...route].reverse(), color, false);
                continue;
            }

            if (ev.peer === 'flood') {
                // A flood goes out on links, not on routes: one dot per radio
                // link this node actually holds, and the relaying happens on
                // the other phone where it will show up in its own map.
                for (const id of layout.directIds) {
                    const to = layout.positions.get(id);
                    if (to) push([layout.self, to], color, false);
                }
                continue;
            }

            const route = layout.routes.get(ev.peerNodeId);
            if (route) push(route, color, ev.kind === 'dropped');
        }

        if (added.length) setFlights((prev) => [...prev, ...added].slice(-MAX_FLIGHTS));
    }, [activity, layout]);

    const retire = (key: number) => setFlights((prev) => prev.filter((f) => f.key !== key));

    return (
        <View>
            <View style={[styles.graph, { width: boardWidth, height: HEIGHT }]}>
                {layout.segments.map((seg) => (
                    <Edge key={seg.key} from={seg.from} to={seg.to} known={seg.known} />
                ))}

                {flights.map((f) => (
                    <Packet key={f.key} flight={f} onDone={() => retire(f.key)} />
                ))}

                <Node
                    at={layout.self}
                    radius={SELF_R}
                    color={accent}
                    label={identity.name}
                    sub={`${selfStored}/${selfKnown}`}
                />

                {layout.nodes.map(({ peer, at }) => (
                    <Node
                        key={peer.nodeId}
                        at={at}
                        radius={PEER_R}
                        color={theme.trust[peer.trust] ?? theme.faint}
                        label={peer.name}
                        sub={`${peer.stored}/${peer.known} · ${peer.hops}h`}
                        highlighted={respondedNodeIds.includes(peer.nodeId)}
                    />
                ))}

                {!peers.length && (
                    <Text
                        style={[
                            styles.graphLabel,
                            { position: 'absolute', bottom: 12, alignSelf: 'center', textAlign: 'center' },
                        ]}
                    >
                        no peers yet — open MeshNet on a second phone
                    </Text>
                )}
            </View>

            <View style={styles.legend}>
                {['HELLO', 'QUERY', 'RESULT', 'DOC_RES', 'ANNOUNCE', 'IDENT_RES'].map((type) => (
                    <View key={type} style={styles.legendItem}>
                        <View style={[styles.legendSwatch, { backgroundColor: theme.wire[type] }]} />
                        <Text style={styles.legendText}>{type.toLowerCase()}</Text>
                    </View>
                ))}
                <View style={styles.legendItem}>
                    <View style={[styles.legendSwatch, { backgroundColor: theme.danger }]} />
                    <Text style={styles.legendText}>dropped</Text>
                </View>
            </View>
        </View>
    );
}

/**
 * One hop, as a rotated 1px View.
 *
 * Every segment drawn is a link some node actually holds — this node's own, or
 * a relay's — with one exception. Beyond two hops the route table knows the
 * next hop and the total distance and nothing in between, so the tail of the
 * path stands in for an unknown number of links and is drawn faint to say so.
 * That is a different claim from "no connection" and it should look different
 * from both a real link and from nothing at all.
 */
function Edge({ from, to, known }: { from: Point; to: Point; known: boolean }) {
    const { theme } = useTheme();
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);

    return (
        <View
            pointerEvents="none"
            style={{
                position: 'absolute',
                left: from.x,
                top: from.y,
                width: length,
                height: 1,
                backgroundColor: known ? theme.border : theme.panelAlt,
                opacity: known ? 1 : 0.7,
                transform: [{ translateY: -0.5 }, { rotateZ: `${angle}rad` }],
                transformOrigin: 'left center',
            }}
        />
    );
}

/**
 * A packet in flight: one Animated value, driven natively, retired on arrival.
 *
 * Interpolated over the whole route rather than one segment, with the stops
 * placed by distance so the dot does not slow down at a corner — a packet that
 * dawdled at every relay would read as the relay being the slow part, which is
 * not what is being measured.
 */
function Packet({ flight, onDone }: { flight: Flight; onDone: () => void }) {
    const t = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        const anim = Animated.timing(t, {
            toValue: 1,
            duration: FLIGHT_MS,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
        });
        anim.start(() => onDone());
        return () => anim.stop();
        // Deliberately once per flight: `onDone` identity changes every render
        // and re-running this would restart the animation forever.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // A dropped packet stops short of its destination rather than arriving,
    // which is the only honest way to draw "this never got there". Cut along
    // the route, so a packet dropped on a two-hop path dies partway down the
    // leg it was actually on.
    const points = flight.dropped ? cutPath(flight.points, 0.55) : flight.points;
    const stops = stopsAlong(points);
    const origin = points[0];

    return (
        <Animated.View
            pointerEvents="none"
            style={{
                position: 'absolute',
                left: origin.x - 3,
                top: origin.y - 3,
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: flight.color,
                opacity: t.interpolate({ inputRange: [0, 0.85, 1], outputRange: [1, 1, 0] }),
                transform: [
                    {
                        translateX: t.interpolate({
                            inputRange: stops,
                            outputRange: points.map((p) => p.x - origin.x),
                        }),
                    },
                    {
                        translateY: t.interpolate({
                            inputRange: stops,
                            outputRange: points.map((p) => p.y - origin.y),
                        }),
                    },
                ],
            }}
        />
    );
}

function Node({
    at,
    radius,
    color,
    label,
    sub,
    highlighted,
}: {
    at: Point;
    radius: number;
    color: string;
    label: string;
    sub: string;
    highlighted?: boolean;
}) {
    const { styles, theme } = useTheme();
    return (
        <View
            pointerEvents="none"
            style={[styles.graphNode, { left: at.x - 46, top: at.y - radius, width: 92 }]}
        >
            <View
                style={[
                    styles.graphDisc,
                    {
                        width: radius * 2,
                        height: radius * 2,
                        borderRadius: radius,
                        borderColor: color,
                        backgroundColor: highlighted ? color : theme.bg,
                    },
                ]}
            >
                {/* A highlighted node is filled, so its initials take the
                    ink-on-accent colour rather than the page ground — cream
                    letters on a cream-adjacent fill would vanish in light. */}
                <Text
                    style={[
                        typography.micro,
                        { color: highlighted ? theme.onAccent : color, fontWeight: '700' },
                    ]}
                >
                    {label.slice(0, 2).toUpperCase()}
                </Text>
            </View>
            <Text style={styles.graphLabel} numberOfLines={1}>
                {label}
            </Text>
            <Text style={styles.graphSub}>{sub}</Text>
        </View>
    );
}

/* ------------------------------- layout -------------------------------- */

interface Layout {
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
 * the far side of the board from the only node that could reach it, and drew
 * the route as a line straight across the middle of the graph.
 */
function computeLayout(width: number, peers: PeerState[]): Layout {
    const self = { x: width / 2, y: HEIGHT / 2 - 8 };
    const positions = new Map<number, Point>();
    const angles = new Map<number, number>();
    const rInner = Math.min(width, HEIGHT) * 0.28;
    const rOuter = Math.min(width, HEIGHT) * 0.44;

    const ordered = [...peers].sort((a, b) => a.nodeId - b.nodeId);
    const direct = ordered.filter((p) => p.hops <= 1);
    const distant = ordered.filter((p) => p.hops > 1);

    const place = (peer: PeerState, angle: number, radius: number) => {
        angles.set(peer.nodeId, angle);
        positions.set(peer.nodeId, {
            x: self.x + Math.cos(angle) * radius,
            y: self.y + Math.sin(angle) * radius,
        });
    };

    // Start at the top and go round. The half-step offset keeps a lone peer off
    // the vertical axis, where its label would sit on the self node's.
    direct.forEach((peer, i) => {
        place(peer, -Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / Math.max(direct.length, 1), rInner);
    });

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

    // Counted from the peer list rather than from what has been placed so far,
    // so the spread does not depend on where in the walk an orphan turns up.
    const known = new Set(ordered.map((p) => p.nodeId));
    let orphan = 0;
    const orphans = distant.filter((p) => !known.has(p.via)).length;
    for (const [relay, group] of byRelay) {
        const base = angles.get(relay);
        group.forEach((peer, i) => {
            // A quarter-turn between siblings, centred on the relay's bearing.
            const offset = (i - (group.length - 1) / 2) * 0.42;
            if (base === undefined) {
                // No relay on screen — the route aged out, or the peer arrived
                // before its relay did. Spread these on their own so they do
                // not all pile onto one bearing.
                place(peer, -Math.PI / 2 + ((orphan++ + 0.5) * 2 * Math.PI) / Math.max(orphans, 1), rOuter);
            } else {
                place(peer, base + offset, rOuter);
            }
        });
    }

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
        const relay = peer.hops > 1 ? positions.get(peer.via) : undefined;

        if (!relay) {
            // Direct, or distant with no relay to point at — the honest drawing
            // of the second case is still a single line, but a faint one, since
            // this node cannot say what it goes through.
            const known = peer.hops <= 1;
            routes.set(peer.nodeId, [self, at]);
            addSegment(`self-${peer.nodeId}`, self, at, known);
            continue;
        }

        routes.set(peer.nodeId, [self, relay, at]);
        addSegment(`self-${peer.via}`, self, relay, true);
        // Exactly two hops means the far leg is one real link the relay holds.
        // Further than that and it stands in for hops this node cannot see.
        addSegment(`${peer.via}-${peer.nodeId}`, relay, at, peer.hops === 2);
    }

    return {
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
