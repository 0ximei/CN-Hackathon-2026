import { useCallback, useEffect, useRef, useState } from 'react';

import type { RouteEntry } from '@core/protocol/router';

import * as DocumentPicker from 'expo-document-picker';

import { llm, type Answer, type LlmStatus } from '../llm/engine';
import { DEFAULT_MODEL, type ModelSpec } from '../llm/models';
import { BleTransport } from '../transport/BleTransport';
import { acquire, release, setKeepAlive } from '../mesh/liveNode';
// Shared with the background daemon, which reads the same preference from the
// same row with no screen running. Two spellings of this key would be a mesh
// that stops when the app does on exactly the phones that asked it not to.
import { BACKGROUND_KEY, backgroundWanted } from '../mesh/daemon';
import { LocalCatalog, type CatalogStats } from '../storage/store';
import {
    createIdentity,
    loadIdentity,
    priorName,
    renameIdentity,
    suggestName,
    type IdentitySession,
} from '../identity/identity';
import { safetyIcons, safetyNumber, type FingerprintIcon } from '../identity/fingerprint';
import { peerPublicKey, type PeerIdentity } from '../identity/trust';
import type { SchemePreference } from './theme';

/** Where the light/dark override lives in the catalog's key/value table. */
const SCHEME_KEY = 'ui.scheme';
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
    const [query, setQuery] = useState<QueryState | null>(null);
    const [searching, setSearching] = useState(false);
    const [llmStatus, setLlmStatus] = useState<LlmStatus>(llm.status);
    const [llmModels, setLlmModels] = useState<{ name: string; uri: string; bytes: number }[]>([]);
    const [answer, setAnswer] = useState<Answer | null>(null);
    const [answerText, setAnswerText] = useState('');
    const [answering, setAnswering] = useState(false);
    const [upload, setUpload] = useState<UploadState>(IDLE_UPLOAD);
    const [outbox, setOutbox] = useState(0);
    const [background, setBackgroundState] = useState(false);
    const [dev, setDev] = useState<DevSettings>({ ttl: 4, packetLoss: 0, cutLinks: [] });
    /**
     * Display name after a rename.
     *
     * Kept apart from `session` on purpose: `session` is what the radio effect
     * depends on, and pushing a new object through it would tear down every
     * live BLE link to change a label.
     */
    const [nameOverride, setNameOverride] = useState<string | null>(null);

    /**
     * Light/dark override, or `null` to follow the system.
     *
     * Persisted through the catalog's existing `kv` table rather than a second
     * storage mechanism — the database is already open by the time anyone can
     * reach the control that changes this.
     */
    const [scheme, setScheme] = useState<SchemePreference>(null);

    const chooseScheme = useCallback((next: SchemePreference) => {
        setScheme(next);
        void catalogRef.current?.kvSet(SCHEME_KEY, next ?? 'system');
    }, []);

    useEffect(() => {
        llm.onStatus = (next) => setLlmStatus({ ...next });
        return () => {
            llm.onStatus = undefined;
        };
    }, []);

    /**
     * Bring back a model the user already downloaded.
     *
     * Loading takes seconds and costs nothing but memory, and a model that was
     * fetched once was fetched on purpose — making someone press the button
     * again after every launch would be a worse default than doing it here.
     */
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            await llm.load();
            if (cancelled) return;
            setLlmModels(await llm.installed());
            const node = nodeRef.current;
            if (node) node.hasLlm = llm.ready;
        })();
        return () => {
            cancelled = true;
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

                // Read before the identity check: the appearance choice applies
                // to the onboarding screen too, and that branch never reaches
                // the code below.
                const stored = await catalog.kvGet(SCHEME_KEY);
                if (cancelled) return;
                if (stored === 'light' || stored === 'dark') setScheme(stored);

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
        const catalog = catalogRef.current;
        if (!catalog) return;

        let cancelled = false;

        // Built synchronously, before anything is awaited.
        //
        // This used to happen inside the async body, which meant an effect torn
        // down before the first await resolved ran a cleanup that had nothing
        // to stop — and the node then came up orphaned, holding a live radio no
        // one had a reference to. Two nodes beaconing one id over one radio is
        // not a state the mesh can recover from, and a Fast Refresh was enough
        // to enter it.
        // Acquired rather than constructed: with background mode on, a node
        // for this identity may already be running with no screen attached, and
        // building a second one would put two nodes on one radio.
        const { node, fresh } = acquire(
            session.identity.id,
            () =>
                new MeshNode(
                    session.identity,
                    new BleTransport(session.identity.id),
                    catalog,
                    { publicKey: session.keys.publicKey, sign: session.sign },
                ),
        );
        const transport = node.transport as BleTransport;
        nodeRef.current = node;

        const refreshDocuments = () => {
            void node.replicator.documentReport().then((docs) => {
                if (!cancelled) setDocuments(docs);
            });
        };

        // MeshNode coalesces these, so each callback is at most a few a second
        // and each payload is already a fresh object — copying again here would
        // only make React work for nothing.
        // Collected, because a node that outlives this screen would otherwise
        // accumulate a set of dead listeners on every remount, each holding a
        // setState for a component that no longer exists.
        const off: (() => void)[] = [
            node.on('peers', setPeers),
            node.on('identities', setIdentities),
            node.on('routes', (r) => setRoutes(new Map(r))),
            node.on('activity', setActivity),
            node.on('stats', setStats),
            node.on('outbox', setOutbox),
            node.on('query', (state) => setQuery(state)),
            node.on('catalog', (next) => {
                setCatalogStats(next);
                refreshDocuments();
            }),
            node.on('replication', (next) => {
                setReplication(next);
                refreshDocuments();
            }),
            transport.onStateChange((state, detail) => {
                if (!cancelled) setRadio({ state, detail });
            }),
        ];

        (async () => {
            try {
                setCatalogStats(catalog.stats());

                // Read capabilities before starting: a device that cannot
                // advertise can still join a mesh, but only as a leaf, and the
                // user should be told rather than left wondering why nobody
                // finds them.
                setCapabilities(BleTransport.capabilities());

                // Restore the background preference before the radio comes up,
                // so a phone that was carrying the mesh yesterday is carrying
                // it again without anyone opening a settings screen.
                const wanted = await backgroundWanted(catalog);
                if (cancelled) return;
                setKeepAlive(wanted);
                setBackgroundState(wanted);
                await transport.setBackground(wanted);

                // A reused node is already running. Starting it again would
                // double every interval it owns.
                if (fresh) {
                    await node.start();
                    if (cancelled) return;
                    node.startReplication();
                }
                setPeers(node.peerList());
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
            for (const cancel of off) cancel();
            release(node);
            if (nodeRef.current === node) nodeRef.current = null;
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

    /**
     * Every path that can end with a model loaded ends here.
     *
     * `hasLlm` is beaconed to the mesh in the HELLO capability bits, so a peer
     * decides where to route a question partly on this. Letting it drift from
     * what the engine can actually do would have the mesh sending questions to
     * a node that answers them extractively while claiming otherwise.
     */
    const settleLlm = useCallback(async () => {
        setLlmModels(await llm.installed());
        const node = nodeRef.current;
        if (node) node.hasLlm = llm.ready;
    }, []);

    const loadLlm = useCallback(async () => {
        await llm.load();
        await settleLlm();
    }, [settleLlm]);

    /** Downloads a model over whatever connectivity exists right now. */
    const fetchLlm = useCallback(
        async (spec: ModelSpec = DEFAULT_MODEL) => {
            await llm.fetch(spec);
            await settleLlm();
        },
        [settleLlm],
    );

    const cancelLlmFetch = useCallback(() => llm.cancelFetch(), []);

    /** Adopts a .gguf the user picked from device storage — needs no network. */
    const importLlm = useCallback(async () => {
        const picked = await DocumentPicker.getDocumentAsync({
            // No MIME type is registered for GGUF, so filtering by one hides
            // every model on the device. The engine validates by loading it.
            type: ['*/*'],
            copyToCacheDirectory: true,
        });
        if (picked.canceled || !picked.assets?.length) return;
        const asset: { name?: string; uri: string } = picked.assets[0];
        await llm.importFile(asset.uri, asset.name ?? 'imported.gguf');
        await settleLlm();
    }, [settleLlm]);

    const unloadLlm = useCallback(async () => {
        await llm.unload();
        await settleLlm();
    }, [settleLlm]);

    const removeLlm = useCallback(
        async (name: string) => {
            await llm.remove(name);
            await settleLlm();
        },
        [settleLlm],
    );

    /**
     * Whether the mesh keeps running once the app is closed.
     *
     * Two halves, and both are needed. The native half raises a foreground
     * service so Android stops reclaiming the process; the JavaScript half
     * stops tearing the node down when the screen goes away. Either alone
     * leaves a node that looks alive and is not.
     */
    const setBackgroundMode = useCallback(async (on: boolean) => {
        setKeepAlive(on);
        setBackgroundState(on);
        await catalogRef.current?.kvSet(BACKGROUND_KEY, on ? '1' : '0');
        const transport = nodeRef.current?.transport as BleTransport | undefined;
        await transport?.setBackground(on);
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
        (nodeId: number): { digits: string; icons: FingerprintIcon[] } | null => {
            const current = sessionRef.current;
            const peer = identities.find((p) => p.nodeId === nodeId);
            if (!current || !peer?.publicKeyHex) return null;
            const theirs = peerPublicKey(peer);
            return {
                digits: safetyNumber(current.keys.publicKey, theirs),
                icons: safetyIcons(current.keys.publicKey, theirs),
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
        scheme,
        chooseScheme,
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
        query,
        searching,
        llmStatus,
        answer,
        answerText,
        answering,
        upload,
        outbox,
        background,
        dev,
        create,
        rename,
        search,
        openHit,
        addFiles,
        forget,
        setBudget,
        setBackgroundMode,
        llmModels,
        loadLlm,
        fetchLlm,
        cancelLlmFetch,
        importLlm,
        unloadLlm,
        removeLlm,
        challengePeer,
        trustPeer,
        untrustPeer,
        safetyFor,
        setDev,
        node: nodeRef.current,
    };
}
