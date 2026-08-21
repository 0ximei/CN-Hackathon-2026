import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadIdentity, type Identity } from '../lib/ids';
import { MeshNode, type ActivityEvent, type MeshHit, type PeerState, type QueryState } from '../protocol/MeshNode';
import type { RouteEntry } from '../protocol/router';
import { BroadcastTransport } from '../transport/BroadcastTransport';
import { WebRTCTransport } from '../transport/WebRTCTransport';
import type { Transport, TransportKind } from '../transport/Transport';
import { shardStore, type IndexStatus, type ShardManifest } from '../search/shard';
import { openDb } from '../search/db';
import { llm, type Answer, type LlmStatus } from '../llm/engine';

const ACTIVITY_LIMIT = 60;

export interface DevSettings {
  ttl: number;
  packetLoss: number;
  /** Peer link ids the operator has severed to force multi-hop routing. */
  cutLinks: string[];
}

export interface MeshState {
  identity: Identity;
  node: MeshNode | null;
  transportKind: TransportKind;
  peers: PeerState[];
  routes: Map<number, RouteEntry>;
  activity: ActivityEvent[];
  index: IndexStatus;
  manifest: ShardManifest | null;
  llmStatus: LlmStatus;
  query: QueryState | null;
  answer: Answer | null;
  answerText: string;
  searching: boolean;
  answering: boolean;
  outbox: number;
  dev: DevSettings;
  error: string | null;
}

export function useMesh(transportKind: TransportKind) {
  const [identity] = useState<Identity>(() => loadIdentity());
  const [node, setNode] = useState<MeshNode | null>(null);
  const [peers, setPeers] = useState<PeerState[]>([]);
  const [routes, setRoutes] = useState<Map<number, RouteEntry>>(new Map());
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [index, setIndex] = useState<IndexStatus>(shardStore.status);
  const [manifest, setManifest] = useState<ShardManifest | null>(null);
  const [llmStatus, setLlmStatus] = useState<LlmStatus>(llm.status);
  const [query, setQuery] = useState<QueryState | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [answerText, setAnswerText] = useState('');
  const [searching, setSearching] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [outbox, setOutbox] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dev, setDev] = useState<DevSettings>({ ttl: 4, packetLoss: 0, cutLinks: [] });

  // Read by the transport's linkUp callback, which is created once and must
  // therefore see current values rather than a captured snapshot.
  const devRef = useRef(dev);
  devRef.current = dev;

  useEffect(() => {
    let cancelled = false;
    let active: MeshNode | null = null;

    // Must happen before anything reads storage: the database is namespaced by
    // node id so sibling tabs are genuinely separate nodes.
    openDb(identity.id);

    const transport: Transport =
      transportKind === 'webrtc'
        ? new WebRTCTransport(String(identity.id))
        : new BroadcastTransport({
            selfId: String(identity.id),
            latencyMs: () => 20 + Math.random() * 30,
            linkUp: (peerId) => !devRef.current.cutLinks.includes(peerId),
          });

    const mesh = new MeshNode(identity, transport);
    active = mesh;

    const offs = [
      mesh.on('peers', setPeers),
      mesh.on('routes', (r) => setRoutes(new Map(r))),
      mesh.on('outbox', setOutbox),
      mesh.on('query', (q) => setQuery(q)),
      mesh.on('activity', (ev) =>
        setActivity((prev) => [ev, ...prev].slice(0, ACTIVITY_LIMIT)),
      ),
    ];

    shardStore.onStatus = (s) => !cancelled && setIndex({ ...s });
    llm.onStatus = (s) => !cancelled && setLlmStatus({ ...s });

    void (async () => {
      try {
        await mesh.start();
        if (!cancelled) setNode(mesh);
        setManifest(await ShardStoreManifest());
        await shardStore.restore();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      for (const off of offs) off();
      active?.stop();
      setNode(null);
    };
  }, [identity, transportKind]);

  // Push dev settings down into the live node.
  useEffect(() => {
    if (!node) return;
    node.packetLoss = dev.packetLoss;
    node.router.setTtl(dev.ttl);
  }, [node, dev.ttl, dev.packetLoss]);

  // Severing a link is a local decision with no wire event behind it, so the
  // transport has to be told to re-publish its peer set.
  useEffect(() => {
    const transport = node?.transport;
    if (transport instanceof BroadcastTransport) transport.refreshLinks();
  }, [node, dev.cutLinks]);

  const loadShard = useCallback(async (shardId: number) => {
    setError(null);
    try {
      await shardStore.load(shardId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadLlm = useCallback(async () => {
    try {
      await llm.load();
      if (node) node.hasLlm = true;
    } catch {
      /* status already reflects the failure; extractive mode continues */
    }
  }, [node]);

  const search = useCallback(
    async (text: string) => {
      if (!node || !text.trim()) return;
      setSearching(true);
      setAnswer(null);
      setAnswerText('');
      setQuery(null);
      try {
        const result = await node.search(text.trim());
        setQuery(result);
        setSearching(false);

        if (!result.hits.length) {
          setAnswer({
            text: 'Not in the mesh — no node holds an answer to that.',
            passages: [],
            mode: 'extractive',
          });
          return;
        }

        setAnswering(true);
        const generated = await llm.answer(
          text.trim(),
          result.hits,
          (hit: MeshHit) => node.fetchFullText(hit),
          setAnswerText,
        );
        setAnswer(generated);
        setAnswerText(generated.text);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSearching(false);
        setAnswering(false);
      }
    },
    [node],
  );

  const state = useMemo<MeshState>(
    () => ({
      identity,
      node,
      transportKind,
      peers,
      routes,
      activity,
      index,
      manifest,
      llmStatus,
      query,
      answer,
      answerText,
      searching,
      answering,
      outbox,
      dev,
      error,
    }),
    [
      identity, node, transportKind, peers, routes, activity, index, manifest,
      llmStatus, query, answer, answerText, searching, answering, outbox, dev, error,
    ],
  );

  return { state, search, loadShard, loadLlm, setDev };
}

/** Kept out of the effect body so the import stays lazy-friendly. */
async function ShardStoreManifest() {
  const { ShardStore } = await import('../search/shard');
  return ShardStore.manifest();
}
