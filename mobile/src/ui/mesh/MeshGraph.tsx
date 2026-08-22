import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Text, View, useWindowDimensions } from 'react-native';

import type { Identity } from '@core/lib/ids';

import type { ActivityEvent, PeerState } from '../../mesh/MeshNode';
import { styles } from './styles';
import { theme, trustColor, wireColor } from '../theme';

/**
 * The topology view.
 *
 * This is the organising element of the browser build's page, and its absence
 * was the biggest thing missing here: without it a phone shows a list of peers
 * and a list of log lines, and nothing connects the two. Every dot travelling
 * an edge below is a real packet the router actually sent, and every edge is a
 * link the transport actually reports as up.
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

interface Point {
    x: number;
    y: number;
}

interface Flight {
    key: number;
    from: Point;
    to: Point;
    color: string;
    dropped: boolean;
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
        const push = (from: Point, to: Point, color: string, dropped: boolean) => {
            added.push({ key: flightKey.current++, from, to, color, dropped });
        };

        for (const ev of fresh) {
            if (ev.kind === 'radio' || ev.kind === 'replicated' || ev.kind === 'evicted') continue;
            const color = ev.kind === 'dropped' ? theme.danger : (wireColor[ev.type] ?? theme.faint);

            if (ev.kind === 'received') {
                const from = layout.positions.get(ev.srcId);
                if (from) push(from, layout.self, color, false);
                continue;
            }

            if (ev.peer === 'flood') {
                for (const id of layout.directIds) {
                    const to = layout.positions.get(id);
                    if (to) push(layout.self, to, color, false);
                }
                continue;
            }

            const to = layout.positions.get(ev.peerNodeId);
            if (to) push(layout.self, to, color, ev.kind === 'dropped');
        }

        if (added.length) setFlights((prev) => [...prev, ...added].slice(-MAX_FLIGHTS));
    }, [activity, layout]);

    const retire = (key: number) => setFlights((prev) => prev.filter((f) => f.key !== key));

    return (
        <View>
            <View style={[styles.graph, { width: boardWidth, height: HEIGHT }]}>
                {layout.nodes.map((node) => (
                    <Edge key={`edge-${node.peer.nodeId}`} from={layout.self} to={node.at} direct={node.peer.hops <= 1} />
                ))}

                {flights.map((f) => (
                    <Packet key={f.key} flight={f} onDone={() => retire(f.key)} />
                ))}

                <Node
                    at={layout.self}
                    radius={SELF_R}
                    color={theme.accent}
                    label={identity.name}
                    sub={`${selfStored}/${selfKnown}`}
                />

                {layout.nodes.map(({ peer, at }) => (
                    <Node
                        key={peer.nodeId}
                        at={at}
                        radius={PEER_R}
                        color={trustColor[peer.trust] ?? theme.faint}
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
                        <View style={[styles.legendSwatch, { backgroundColor: wireColor[type] }]} />
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
 * One link, as a rotated 1px View.
 *
 * Two-hop peers get a dashed-looking dimmer line, because the edge between this
 * node and them is not a link — it is a route, and drawing it the same way as a
 * real radio link would claim a connection that does not exist.
 */
function Edge({ from, to, direct }: { from: Point; to: Point; direct: boolean }) {
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
                backgroundColor: direct ? theme.border : theme.panelAlt,
                opacity: direct ? 1 : 0.8,
                transform: [{ translateY: -0.5 }, { rotateZ: `${angle}rad` }],
                transformOrigin: 'left center',
            }}
        />
    );
}

/** A packet in flight: one Animated value, driven natively, retired on arrival. */
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
    // which is the only honest way to draw "this never got there".
    const reach = flight.dropped ? 0.55 : 1;

    return (
        <Animated.View
            pointerEvents="none"
            style={{
                position: 'absolute',
                left: flight.from.x - 3,
                top: flight.from.y - 3,
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: flight.color,
                opacity: t.interpolate({ inputRange: [0, 0.85, 1], outputRange: [1, 1, 0] }),
                transform: [
                    {
                        translateX: t.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0, (flight.to.x - flight.from.x) * reach],
                        }),
                    },
                    {
                        translateY: t.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0, (flight.to.y - flight.from.y) * reach],
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
                <Text style={{ color: highlighted ? theme.bg : color, fontSize: 11, fontWeight: '700' }}>
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

interface Layout {
    self: Point;
    nodes: { peer: PeerState; at: Point }[];
    positions: Map<number, Point>;
    directIds: number[];
}

/**
 * Deterministic ring layout.
 *
 * Direct neighbours sit on an inner ring, anything further out on an outer one,
 * so "two hops away" is legible as distance rather than only as a number in a
 * label. Order is by node id so a given phone lands in the same place on every
 * launch of the demo.
 */
function computeLayout(width: number, peers: PeerState[]): Layout {
    const self = { x: width / 2, y: HEIGHT / 2 - 8 };
    const positions = new Map<number, Point>();
    const rInner = Math.min(width, HEIGHT) * 0.28;
    const rOuter = Math.min(width, HEIGHT) * 0.44;

    const ordered = [...peers].sort((a, b) => a.nodeId - b.nodeId);
    const nodes = ordered.map((peer, i) => {
        // Start at the top and go round. The half-step offset keeps a lone peer
        // off the vertical axis, where its label would sit on the self node's.
        const angle = -Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / Math.max(ordered.length, 1);
        const radius = peer.hops <= 1 ? rInner : rOuter;
        const at = {
            x: self.x + Math.cos(angle) * radius,
            y: self.y + Math.sin(angle) * radius,
        };
        positions.set(peer.nodeId, at);
        return { peer, at };
    });

    return {
        self,
        nodes,
        positions,
        directIds: ordered.filter((p) => p.hops <= 1).map((p) => p.nodeId),
    };
}
