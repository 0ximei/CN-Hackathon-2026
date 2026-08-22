import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityEvent, PeerState } from '../protocol/MeshNode';
import type { RouteEntry } from '../protocol/router';
import type { Identity } from '../lib/ids';

/**
 * The topology view. This is the page's organising element, not a decoration:
 * every dot on an edge is a real packet that the router actually sent, and
 * every edge is a link the transport actually reports as up.
 *
 * Layout is a deterministic ring rather than a force simulation. On stage you
 * want the same node in the same place every run; a force layout re-settles
 * differently on every render and makes the demo hard to narrate.
 */

const W = 460;
const H = 440;
const CX = W / 2;
const CY = H / 2;
const R_DIRECT = 112;
// Far enough past the direct ring that a node sitting on the same radial as
// its next hop does not have its two label lines land on that hop's circle.
const R_FAR = 190;
const FLIGHT_MS = 620;
const PULSE_MS = 900;
const MAX_FLIGHTS = 36;

const WIRE_COLOR: Record<string, string> = {
  HELLO: 'var(--wire-hello)',
  QUERY: 'var(--wire-query)',
  RESULT: 'var(--wire-result)',
  DOC_REQ: 'var(--wire-doc)',
  DOC_RES: 'var(--wire-doc)',
  ACK: 'var(--wire-hello)',
};

interface Point {
  x: number;
  y: number;
}

interface Flight {
  key: number;
  from: Point;
  to: Point;
  color: string;
  started: number;
  dropped: boolean;
}

interface Props {
  identity: Identity;
  /** This node's own shard number, or '?' before indexing completes. */
  /** Passages whose body this node stores — the new "what do you carry". */
  selfStored: number;
  peers: PeerState[];
  routes: Map<number, RouteEntry>;
  activity: ActivityEvent[];
  respondedNodeIds: number[];
}

export function MeshGraph({ identity, selfStored, peers, routes, activity, respondedNodeIds }: Props) {
  const layout = useMemo(() => computeLayout(identity.id, peers, routes), [identity.id, peers, routes]);

  const flights = useRef<Flight[]>([]);
  const flightKey = useRef(0);
  const pulses = useRef(new Map<number, number>());
  const lastSeenAt = useRef(0);
  const [, forceTick] = useState(0);

  // Turn router events into flights along the edges they actually traversed.
  useEffect(() => {
    const fresh = activity.filter((ev) => ev.at > lastSeenAt.current);
    if (!fresh.length) return;
    lastSeenAt.current = activity[0]?.at ?? lastSeenAt.current;

    const now = performance.now();
    for (const ev of fresh.reverse()) {
      const color = ev.kind === 'dropped' ? 'var(--wire-drop)' : (WIRE_COLOR[ev.type] ?? 'var(--wire-hello)');

      if (ev.kind === 'received') {
        const from = layout.positions.get(ev.srcId);
        if (from) {
          push(flights, flightKey, { from, to: layout.self, color, started: now, dropped: false });
          if (ev.type === 'RESULT') pulses.current.set(ev.srcId, now);
        }
        continue;
      }

      if (ev.peer === 'flood') {
        for (const peer of layout.directIds) {
          const to = layout.positions.get(peer);
          if (to) push(flights, flightKey, { from: layout.self, to, color, started: now, dropped: false });
        }
        continue;
      }

      const to = layout.positions.get(Number(ev.peer));
      if (to) {
        push(flights, flightKey, {
          from: layout.self,
          to,
          color,
          started: now,
          dropped: ev.kind === 'dropped',
        });
      }
    }
    forceTick((t) => t + 1);
  }, [activity, layout]);

  // One rAF loop, running only while something is in flight.
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const now = performance.now();
      const before = flights.current.length;
      flights.current = flights.current.filter((f) => now - f.started < FLIGHT_MS);
      for (const [id, at] of pulses.current) if (now - at > PULSE_MS) pulses.current.delete(id);

      if (flights.current.length || before || pulses.current.size) forceTick((t) => t + 1);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  const now = performance.now();
  const responded = new Set(respondedNodeIds);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="mesh-graph"
      role="img"
      aria-label={`Mesh topology: ${peers.length} peers reachable, ${layout.directIds.length} direct links`}
    >
      <g>
        {layout.edges.map((edge) => (
          <line
            key={`${edge.from}-${edge.to}`}
            x1={edge.a.x}
            y1={edge.a.y}
            x2={edge.b.x}
            y2={edge.b.y}
            className="mesh-edge"
          />
        ))}
      </g>

      <g>
        {flights.current.map((f) => {
          const t = Math.min(1, (now - f.started) / FLIGHT_MS);
          // Ease-out so the dot decelerates into the node, which reads as arrival.
          const e = 1 - Math.pow(1 - t, 3);
          const x = f.from.x + (f.to.x - f.from.x) * (f.dropped ? e * 0.55 : e);
          const y = f.from.y + (f.to.y - f.from.y) * (f.dropped ? e * 0.55 : e);
          return (
            <circle
              key={f.key}
              cx={x}
              cy={y}
              r={f.dropped ? 2.4 : 3.4}
              fill={f.color}
              opacity={f.dropped ? 0.9 * (1 - t) : 1 - t * 0.25}
            />
          );
        })}
      </g>

      <g>
        {[...layout.positions].map(([nodeId, p]) => {
          const peer = peers.find((x) => x.nodeId === nodeId);
          const pulse = pulses.current.get(nodeId);
          const pulseT = pulse ? Math.min(1, (now - pulse) / PULSE_MS) : null;
          return (
            <g key={nodeId} className="mesh-node">
              {pulseT !== null && (
                <circle cx={p.x} cy={p.y} r={16 + pulseT * 18} className="mesh-pulse" opacity={1 - pulseT} />
              )}
              <circle
                cx={p.x}
                cy={p.y}
                r={15}
                className={`mesh-dot${responded.has(nodeId) ? ' is-responded' : ''}`}
              />
              <text x={p.x} y={p.y + 3.5} className="mesh-shard">
                {peer ? peer.stored : '?'}
              </text>
              <text x={p.x} y={p.y + 31} className="mesh-label">
                {peer?.name ?? `#${nodeId.toString(16).slice(0, 4)}`}
              </text>
              <text x={p.x} y={p.y + 43} className="mesh-sub">
                {peer ? `knows ${peer.known} · ${peer.hops}h` : 'discovering'}
              </text>
            </g>
          );
        })}

        <g className="mesh-node">
          <circle cx={CX} cy={CY} r={19} className="mesh-dot is-self" />
          <text x={CX} y={CY + 4} className="mesh-shard is-self">
            {selfStored}
          </text>
          <text x={CX} y={CY + 36} className="mesh-label is-self">
            {identity.name} · you
          </text>
        </g>
      </g>
    </svg>
  );
}

function push(
  ref: React.RefObject<Flight[]>,
  keyRef: React.RefObject<number>,
  flight: Omit<Flight, 'key'>,
) {
  if (ref.current.length >= MAX_FLIGHTS) ref.current.shift();
  ref.current.push({ ...flight, key: keyRef.current++ });
}

interface Layout {
  self: Point;
  positions: Map<number, Point>;
  directIds: number[];
  edges: { from: number; to: number; a: Point; b: Point }[];
}

function computeLayout(selfId: number, peers: PeerState[], routes: Map<number, RouteEntry>): Layout {
  const self: Point = { x: CX, y: CY };
  const positions = new Map<number, Point>();

  // A node is a direct neighbour when its learned next hop is the node itself.
  const directIds: number[] = [];
  const indirect: { nodeId: number; via: number }[] = [];

  for (const peer of peers) {
    const route = routes.get(peer.nodeId);
    const via = route ? Number(route.peerId) : peer.nodeId;
    if (!route || via === peer.nodeId) directIds.push(peer.nodeId);
    else indirect.push({ nodeId: peer.nodeId, via });
  }
  directIds.sort((a, b) => a - b);

  directIds.forEach((nodeId, i) => {
    // Start at the top and walk clockwise, so ordering is stable across runs.
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, directIds.length);
    positions.set(nodeId, { x: CX + R_DIRECT * Math.cos(angle), y: CY + R_DIRECT * Math.sin(angle) });
  });

  for (const { nodeId, via } of indirect) {
    const anchor = positions.get(via);
    if (!anchor) {
      const angle = -Math.PI / 2 + (positions.size * 0.9);
      positions.set(nodeId, { x: CX + R_FAR * Math.cos(angle), y: CY + R_FAR * Math.sin(angle) });
      continue;
    }
    // Push the far node outward past its next hop, fanned slightly so several
    // nodes behind the same relay stay separable.
    const dx = anchor.x - CX;
    const dy = anchor.y - CY;
    const base = Math.atan2(dy, dx);
    const siblings = indirect.filter((n) => n.via === via);
    const rank = siblings.findIndex((n) => n.nodeId === nodeId);
    const spread = siblings.length > 1 ? (rank - (siblings.length - 1) / 2) * 0.42 : 0;
    const angle = base + spread;
    positions.set(nodeId, { x: CX + R_FAR * Math.cos(angle), y: CY + R_FAR * Math.sin(angle) });
  }

  const edges: Layout['edges'] = [];
  for (const nodeId of directIds) {
    edges.push({ from: selfId, to: nodeId, a: self, b: positions.get(nodeId)! });
  }
  for (const { nodeId, via } of indirect) {
    const a = positions.get(via);
    const b = positions.get(nodeId);
    if (a && b) edges.push({ from: via, to: nodeId, a, b });
  }

  return { self, positions, directIds, edges };
}
