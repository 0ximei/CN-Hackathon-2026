import { useCallback, useEffect, useRef, useState } from 'react';

import type { RouteEntry } from '@core/protocol/router';

import { llm, type Answer, type LlmStatus } from '../llm/engine';
import { BleTransport } from '../transport/BleTransport';
import { LocalCatalog, type CatalogStats } from '../storage/store';
import {
    createIdentity,
    loadIdentity,
    priorName,
    renameIdentity,
    suggestName,
    type IdentitySession,
} from '../identity/identity';
import { safetyEmoji, safetyNumber } from '../identity/fingerprint';
import { peerPublicKey, type PeerIdentity } from '../identity/trust';
import { coverageOf, hasSeeded, reseed, seedCorpus, type SeedReport } from '../mesh/bootstrap';
import {
    MeshNode,
    type ActivityEvent,
    type MeshHit,
    type MeshStats,
    type PeerState,
    type QueryState,
} from '../mesh/MeshNode';
import type { DocReplicaInfo, ReplicationStats } from '../replication/Replicator';
import type { BleCapabilities } from '../../modules/ble-mesh';

export type Phase = 'booting' | 'onboarding' | 'ready' | 'error';

export interface RadioState {
    state: string;
    detail: string;
}

/** The knobs that exist to break the network on purpose, on stage. */
export interface DevSettings {
    ttl: number;
    packetLoss: number;
    /** Transport peer ids the operator has severed, to force multi-hop routing. */
    cutLinks: string[];
}

export interface UploadState {
    busy: boolean;
    label: string;
    done: number;
    total: number;
}

const EMPTY_STATS: MeshStats = {
    sent: 0,
    received: 0,
    forwarded: 0,
    dropped: 0,
    duplicates: 0,
    queued: 0,
};

const EMPTY_CATALOG: CatalogStats = {
    documents: 0,
    known: 0,
    stored: 0,
    metaBytes: 0,
    bodyBytes: 0,
};

const IDLE_UPLOAD: UploadState = { busy: false, label: '', done: 0, total: 0 };

/**
 * Boots the node once and republishes its events as React state.
 *
 * Everything below this hook is plain TypeScript with no React in it — the same
 * separation the web build keeps — so the mesh runs whether or not anything is
 * rendering it. The refs exist because a `MeshNode` owns a radio: re-creating
 * one on a re-render would tear down live BLE links.
 *
 * Startup has one more stage than it used to. The node id is derived from a
 * keypair, and the keypair is created by the user on the identity screen, so
 * there is a real state between "database open" and "radio running" in which
 * this device does not yet have an identity to run as.
 */
export function useMesh() {
    const nodeRef = useRef<MeshNode | null>(null);
    const catalogRef = useRef<LocalCatalog | null>(null);
    const sessionRef = useRef<IdentitySession | null>(null);

    const [phase, setPhase] = useState<Phase>('booting');
    const [error, setError] = useState('');
    const [session, setSession] = useState<IdentitySession | null>(null);
    const [suggestedName, setSuggestedName] = useState('');
    const [peers, setPeers] = useState<PeerState[]>([]);
    const [identities, setIdentities] = useState<PeerIdentity[]>([]);
    const [routes, setRoutes] = useState<Map<number, RouteEntry>>(new Map());
    const [activity, setActivity] = useState<ActivityEvent[]>([]);
    const [stats, setStats] = useState<MeshStats>(EMPTY_STATS);
    const [radio, setRadio] = useState<RadioState>({ state: 'idle', detail: '' });
    const [catalogStats, setCatalogStats] = useState<CatalogStats>(EMPTY_CATALOG);
    const [documents, setDocuments] = useState<DocReplicaInfo[]>([]);
    const [replication, setReplication] = useState<ReplicationStats | null>(null);
    const [capabilities, setCapabilities] = useState<BleCapabilities | null>(null);
    const [coverage, setCoverage] = useState(0.6);
    const [seedReport, setSeedReport] = useState<SeedReport | null>(null);
    const [query, setQuery] = useState<QueryState | null>(null);
    const [searching, setSearching] = useState(false);
    const [llmStatus, setLlmStatus] = useState<LlmStatus>(llm.status);
    const [answer, setAnswer] = useState<Answer | null>(null);
    const [answerText, setAnswerText] = useState('');
    const [answering, setAnswering] = useState(false);
    const [upload, setUpload] = useState<UploadState>(IDLE_UPLOAD);
    const [outbox, setOutbox] = useState(0);
    const [dev, setDev] = useState<DevSettings>({ ttl: 4, packetLoss: 0, cutLinks: [] });
    /**
     * Display name after a rename.
     *
     * Kept apart from `session` on purpose: `session` is what the radio effect
     * depends on, and pushing a new object through it would tear down every
     * live BLE link to change a label.
     */
    const [nameOverride, setNameOverride] = useState<string | null>(null);

    useEffect(() => {
        llm.onStatus = (next) => setLlmStatus({ ...next });
        return () => {
            llm.onStatus = undefined;
        };
    }, []);

    /* ---------------------------- stage one --------------------------- */

    // Open storage and look for an identity. Nothing touches the radio here:
    // the node id decides the BLE dial/wait tie-break and every holder record
    // written, so starting without one would mean restarting immediately.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const catalog = await LocalCatalog.open();
                if (cancelled) return;
                catalogRef.current = catalog;
                setCatalogStats(catalog.stats());

                const existing = await loadIdentity(catalog);
                if (cancelled) return;
                if (existing) {
                    sessionRef.current = existing;
                    setSession(existing);
                } else {
                    setSuggestedName((await priorName(catalog)) ?? suggestName());
                    setPhase('onboarding');
                }
            } catch (e) {
                if (cancelled) return;
                setError(e instanceof Error ? e.message : String(e));
                setPhase('error');
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    /* ---------------------------- stage two --------------------------- */

    // With an identity in hand, seed the corpus if this is a first launch and
    // bring the radio up.
    useEffect(() => {
        if (!session) return;
        let cancelled = false;
        let node: MeshNode | null = null;

        (async () => {
            try {
                const catalog = catalogRef.current;
                if (!catalog) return;

                if (!(await hasSeeded(catalog))) {
                    setSeedReport(await seedCorpus(catalog, session.identity.id));
                }
                setCoverage(await coverageOf(catalog));
                setCatalogStats(catalog.stats());

                // Read capabilities before starting: a device that cannot
                // advertise can still join a mesh, but only as a leaf, and the
                // user should be told rather than left wondering why nobody
                // finds them.
                setCapabilities(BleTransport.capabilities());

                const transport = new BleTransport(session.identity.id);
                node = new MeshNode(session.identity, transport, catalog, {
                    publicKey: session.keys.publicKey,
                    sign: session.sign,
                });
                nodeRef.current = node;

                const refreshDocuments = () => {
                    void node?.replicator.documentReport().then((docs) => {
                        if (!cancelled) setDocuments(docs);
                    });
                };

                node.on('peers', setPeers);
                node.on('identities', setIdentities);
                node.on('routes', (r) => setRoutes(new Map(r)));
                node.on('activity', (events) => setActivity([...events]));
                node.on('stats', setStats);
                node.on('outbox', setOutbox);
                node.on('query', (state) => setQuery(state));
                node.on('catalog', (next) => {
                    setCatalogStats(next);
                    refreshDocuments();
                });
                node.on('replication', (next) => {
                    setReplication(next);
                    refreshDocuments();
                });
                transport.onStateChange((state, detail) => setRadio({ state, detail }));

                await node.start();
                if (cancelled) return;
                node.startReplication();
                refreshDocuments();
                setPhase('ready');
            } catch (e) {
                if (cancelled) return;
                setError(e instanceof Error ? e.message : String(e));
                setPhase('error');
            }
        })();

        return () => {
            cancelled = true;
            node?.stop();
            nodeRef.current = null;
        };
    }, [session]);

    // Push the network controls down into the live node. Severing is a local
    // decision with no wire event behind it, so the transport has to be told.
    useEffect(() => {
        const node = nodeRef.current;
        if (!node) return;
        node.packetLoss = dev.packetLoss;
        node.router.setTtl(dev.ttl);
    }, [dev.ttl, dev.packetLoss, phase]);

    useEffect(() => {
        nodeRef.current?.transport?.setSevered?.(dev.cutLinks);
    }, [dev.cutLinks, phase]);

    /* ----------------------------- actions ---------------------------- */

    const create = useCallback(async (name: string) => {
        const catalog = catalogRef.current;
        if (!catalog) return;
        setPhase('booting');
        try {
            const next = await createIdentity(catalog, name);
            sessionRef.current = next;
            setSession(next);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setPhase('error');
        }
    }, []);

    const rename = useCallback(
        async (name: string) => {
            const catalog = catalogRef.current;
            const current = sessionRef.current;
            if (!catalog || !current) return;
            const next = await renameIdentity(catalog, current, name);
            sessionRef.current = next;
            nodeRef.current?.rename(next.identity.name);
            setNameOverride(next.identity.name);
        },
        [],
    );

    const search = useCallback(async (text: string) => {
        const node = nodeRef.current;
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
                async (hit: MeshHit) => node.fetchFullText(hit),
                setAnswerText,
            );
            setAnswer(generated);
            setAnswerText(generated.text);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSearching(false);
            setAnswering(false);
        }
    }, []);

    /**
     * Pull the full passage for a hit the user tapped.
     *
     * The node re-emits its query state once the body lands, so there is
     * nothing to return — the row expands through the same `query` event that
     * filled it in the first place.
     */
    const openHit = useCallback(
        async (docId: number) => {
            const node = nodeRef.current;
            const hit = query?.hits.find((h) => h.docId === docId);
            if (!node || !hit) return;
            await node.fetchFullText(hit);
        },
        [query],
    );

    const changeCoverage = useCallback(
        async (next: number) => {
            const catalog = catalogRef.current;
            const current = sessionRef.current;
            if (!catalog || !current) return;
            setSeedReport(await reseed(catalog, current.identity.id, next));
            setCoverage(next);
            setCatalogStats(catalog.stats());
            void nodeRef.current?.replicator.reconcile();
        },
        [],
    );

    const addFiles = useCallback(
        async (files: Array<{ name: string; text: string }>) => {
            const node = nodeRef.current;
            if (!node) return;
            for (const file of files) {
                setUpload({ busy: true, label: file.name, done: 0, total: 0 });
                try {
                    await node.upload(file.name, file.text, (done, total) =>
                        setUpload({ busy: true, label: file.name, done, total }),
                    );
                } finally {
                    setUpload(IDLE_UPLOAD);
                }
            }
            setError('');
        },
        [],
    );

    const forget = useCallback(async (docKey: number) => {
        await nodeRef.current?.forget(docKey);
    }, []);

    const setBudget = useCallback(async (bytes: number) => {
        await nodeRef.current?.setBudget(bytes);
        const catalog = catalogRef.current;
        if (catalog) setCatalogStats(catalog.stats());
    }, []);

    const loadLlm = useCallback(async () => {
        try {
            await llm.load();
            const node = nodeRef.current;
            if (node) node.hasLlm = llm.ready;
        } catch {
            // The engine falls back to extractive answers automatically.
        }
    }, []);

    const challengePeer = useCallback((nodeId: number) => {
        nodeRef.current?.challenge(nodeId);
    }, []);

    const trustPeer = useCallback(async (nodeId: number) => {
        await nodeRef.current?.markTrusted(nodeId);
    }, []);

    const untrustPeer = useCallback(async (nodeId: number) => {
        await nodeRef.current?.clearTrust(nodeId);
    }, []);

    /**
     * The number both phones show while two people verify each other.
     *
     * Derived from both public keys, so it is meaningless anywhere else and
     * identical on both screens without either side going first. Empty until
     * the peer has actually proven its key — a safety number for an unverified
     * peer would be a comparison of something nobody has established.
     */
    const safetyFor = useCallback(
        (nodeId: number): { digits: string; emoji: string } | null => {
            const current = sessionRef.current;
            const peer = identities.find((p) => p.nodeId === nodeId);
            if (!current || !peer?.publicKeyHex) return null;
            const theirs = peerPublicKey(peer);
            return {
                digits: safetyNumber(current.keys.publicKey, theirs),
                emoji: safetyEmoji(current.keys.publicKey, theirs),
            };
        },
        [identities],
    );

    const identity = sessionRef.current
        ? { ...sessionRef.current.identity, name: nameOverride ?? sessionRef.current.identity.name }
        : null;

    return {
        phase,
        error,
        identity,
        fingerprint: sessionRef.current?.fingerprint ?? null,
        suggestedName,
        peers,
        identities,
        routes,
        activity,
        stats,
        radio,
        catalogStats,
        documents,
        replication,
        capabilities,
        coverage,
        seedReport,
        query,
        searching,
        llmStatus,
        answer,
        answerText,
        answering,
        upload,
        outbox,
        dev,
        create,
        rename,
        search,
        openHit,
        changeCoverage,
        addFiles,
        forget,
        setBudget,
        loadLlm,
        challengePeer,
        trustPeer,
        untrustPeer,
        safetyFor,
        setDev,
        node: nodeRef.current,
    };
}
