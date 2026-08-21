import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadIdentity, type Identity } from '../lib/ids';
import {
  MeshNode,
  type ActivityEvent,
  type MeshHit,
  type PeerState,
  type QueryState,
} from '../protocol/MeshNode';
import type { RouteEntry } from '../protocol/router';
import { BroadcastTransport } from '../transport/BroadcastTransport';
import { WebRTCTransport } from '../transport/WebRTCTransport';
import type { Transport, TransportKind } from '../transport/Transport';
import { catalog, type IndexStatus } from '../search/catalog';
import type { DocReplicaInfo, ReplicationStats } from '../replication/Replicator';
import { openDb, setKV } from '../search/db';
import { llm, type Answer, type LlmStatus } from '../llm/engine';

const ACTIVITY_LIMIT = 60;

/** Sample documents a visitor can upload if they have no files to hand. */
export interface SampleDoc {
  file: string;
  title: string;
  bytes: number;
  words: number;
}

export interface SampleManifest {
  builtAt: string;
  documents: number;
  totalWords: number;
  samples: SampleDoc[];
}

export interface DevSettings {
  ttl: number;
  packetLoss: number;
  /** Peer link ids the operator has severed to force multi-hop routing. */
  cutLinks: string[];
}

export interface UploadState {
  busy: boolean;
  label: string;
  done: number;
  total: number;
}

export interface MeshState {
  identity: Identity;
  node: MeshNode | null;
  transportKind: TransportKind;
  peers: PeerState[];
  routes: Map<number, RouteEntry>;
  activity: ActivityEvent[];
  index: IndexStatus;
  samples: SampleManifest | null;
  replication: ReplicationStats | null;
  documents: DocReplicaInfo[];
  upload: UploadState;
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

const IDLE_UPLOAD: UploadState = { busy: false, label: '', done: 0, total: 0 };

export function useMesh(transportKind: TransportKind) {
  const [identity] = useState<Identity>(() => loadIdentity());
  const [node, setNode] = useState<MeshNode | null>(null);
  const [peers, setPeers] = useState<PeerState[]>([]);
  const [routes, setRoutes] = useState<Map<number, RouteEntry>>(new Map());
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [index, setIndex] = useState<IndexStatus>(catalog.status);
  const [samples, setSamples] = useState<SampleManifest | null>(null);
  const [replication, setReplication] = useState<ReplicationStats | null>(null);
  const [documents, setDocuments] = useState<DocReplicaInfo[]>([]);
  const [upload, setUpload] = useState<UploadState>(IDLE_UPLOAD);
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

    const refreshDocuments = () => {
      void mesh.replicator.documentReport().then((docs) => {
        if (!cancelled) setDocuments(docs);
      });
    };

    const offs = [
      mesh.on('peers', setPeers),
      mesh.on('routes', (r) => setRoutes(new Map(r))),
      mesh.on('outbox', setOutbox),
      mesh.on('query', (q) => setQuery(q)),
      mesh.on('replication', (s) => {
        setReplication(s);
        refreshDocuments();
      }),
      mesh.on('catalog', refreshDocuments),
      mesh.on('activity', (ev) => setActivity((prev) => [ev, ...prev].slice(0, ACTIVITY_LIMIT))),
    ];

    catalog.onStatus = (s) => !cancelled && setIndex({ ...s });
    llm.onStatus = (s) => !cancelled && setLlmStatus({ ...s });

    void (async () => {
      try {
        await mesh.start();
        if (!cancelled) setNode(mesh);

        // The sample list is optional furniture — a failure to fetch it must not
        // stop the node from working with the user's own documents.
        void fetch('/corpus/manifest.json')
          .then((r) => (r.ok ? r.json() : null))
          .then((m) => !cancelled && setSamples(m))
          .catch(() => undefined);

        await catalog.start();
        if (cancelled) return;
        mesh.startReplication();
        refreshDocuments();
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

  const addDocument = useCallback(
    async (filename: string, text: string) => {
      if (!node) return;
      setError(null);
      setUpload({ busy: true, label: filename, done: 0, total: 0 });
      try {
        await node.upload(filename, text, (done, total) =>
          setUpload({ busy: true, label: filename, done, total }),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setUpload(IDLE_UPLOAD);
      }
    },
    [node],
  );

  const addFiles = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        await addDocument(file.name, await file.text());
      }
    },
    [addDocument],
  );

  const addSample = useCallback(
    async (sample: SampleDoc) => {
      const res = await fetch(`/corpus/${sample.file}`);
      if (!res.ok) {
        setError(`sample ${sample.file} is missing — run \`npm run corpus:build\``);
        return;
      }
      await addDocument(sample.file, await res.text());
    },
    [addDocument],
  );

  const forgetDocument = useCallback(
    async (docKey: number) => {
      await catalog.forget(docKey);
      if (node) void node.replicator.reconcile();
    },
    [node],
  );

  /**
   * Changes how much room this node offers the mesh.
   *
   * Capacity is one of the four placement signals, and it is the only one an
   * operator can move directly — dropping the budget below what is already
   * stored puts the node under pressure and makes it shed bodies while keeping
   * the metadata, which is the two-tier split doing its job on demand.
   */
  const setBudget = useCallback(
    async (budgetBytes: number) => {
      await setKV('storageBudget', budgetBytes);
      if (node) await node.replicator.reconcile();
    },
    [node],
  );

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
      samples,
      replication,
      documents,
      upload,
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
      identity, node, transportKind, peers, routes, activity, index, samples,
      replication, documents, upload, llmStatus, query, answer, answerText,
      searching, answering, outbox, dev, error,
    ],
  );

  return { state, search, addFiles, addSample, forgetDocument, setBudget, loadLlm, setDev };
}
