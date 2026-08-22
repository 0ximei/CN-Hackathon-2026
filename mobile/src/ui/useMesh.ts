import { useCallback, useEffect, useRef, useState } from 'react';

import type { Identity } from '@core/lib/ids';
import { parseDocument } from '@core/lib/chunk';
import { llm, type Answer, type LlmStatus } from '../llm/engine';

import { BleTransport } from '../transport/BleTransport';
import { LocalCatalog, type CatalogStats } from '../storage/store';
import { loadIdentity } from '../lib/identity';
import { coverageOf, hasSeeded, reseed, seedCorpus, type SeedReport } from '../mesh/bootstrap';
import {
    MeshNode,
    type ActivityEvent,
    type MeshHit,
    type MeshStats,
    type PeerState,
    type QueryState,
} from '../mesh/MeshNode';
import type { BleCapabilities } from '../../modules/ble-mesh';
import { normalizeUploadedText } from '@core/lib/textUpload';

export type Phase = 'booting' | 'ready' | 'error';

export interface RadioState {
    state: string;
    detail: string;
}

const EMPTY_STATS: MeshStats = {
    sent: 0,
    received: 0,
    forwarded: 0,
    dropped: 0,
    duplicates: 0,
    queued: 0,
};

/**
 * Boots the node once and republishes its events as React state.
 *
 * Everything below this hook is plain TypeScript with no React in it — the same
 * separation the web build keeps — so the mesh runs whether or not anything is
 * rendering it. The refs exist because a `MeshNode` owns a radio: re-creating
 * one on a re-render would tear down live BLE links.
 */
export function useMesh() {
    const nodeRef = useRef<MeshNode | null>(null);
    const catalogRef = useRef<LocalCatalog | null>(null);

    const [phase, setPhase] = useState<Phase>('booting');
    const [error, setError] = useState('');
    const [identity, setIdentity] = useState<Identity | null>(null);
    const [peers, setPeers] = useState<PeerState[]>([]);
    const [activity, setActivity] = useState<ActivityEvent[]>([]);
    const [stats, setStats] = useState<MeshStats>(EMPTY_STATS);
    const [radio, setRadio] = useState<RadioState>({ state: 'idle', detail: '' });
    const [catalogStats, setCatalogStats] = useState<CatalogStats>({
        documents: 0,
        chunks: 0,
        bytes: 0,
    });
    const [capabilities, setCapabilities] = useState<BleCapabilities | null>(null);
    const [coverage, setCoverage] = useState(0.6);
    const [seedReport, setSeedReport] = useState<SeedReport | null>(null);
    const [query, setQuery] = useState<QueryState | null>(null);
    const [searching, setSearching] = useState(false);
    const [llmStatus, setLlmStatus] = useState<LlmStatus>(llm.status);
    const [answer, setAnswer] = useState<Answer | null>(null);
    const [answerText, setAnswerText] = useState('');
    const [answering, setAnswering] = useState(false);

    useEffect(() => {
        llm.onStatus = (next) => setLlmStatus({ ...next });
        return () => {
            llm.onStatus = undefined;
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        let node: MeshNode | null = null;

        (async () => {
            try {
                const catalog = await LocalCatalog.open();
                catalogRef.current = catalog;

                const id = await loadIdentity(catalog);
                if (cancelled) return;
                setIdentity(id);

                if (!(await hasSeeded(catalog))) {
                    setSeedReport(await seedCorpus(catalog, id.id));
                }
                setCoverage(await coverageOf(catalog));
                setCatalogStats(catalog.stats());

                // Read capabilities before starting: a device that cannot advertise
                // can still join a mesh, but only as a leaf, and the user should be
                // told that rather than left wondering why nobody finds them.
                setCapabilities(BleTransport.capabilities());

                const transport = new BleTransport(id.id);
                node = new MeshNode(id, transport, catalog);
                nodeRef.current = node;

                node.on('peers', setPeers);
                node.on('activity', setActivity);
                node.on('stats', setStats);
                node.on('query', (state) => setQuery({ ...state, hits: [...state.hits] }));
                transport.onStateChange((state, detail) => setRadio({ state, detail }));

                await node.start();
                if (cancelled) return;
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
    }, []);

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
     * The node re-emits its query state once the body lands, so there is nothing
     * to return here — the row expands through the same `query` event that filled
     * it in the first place.
     */
    const openHit = useCallback(async (docId: number) => {
        const node = nodeRef.current;
        if (!node) return;
        const hit = query?.hits.find((h) => h.docId === docId);
        if (!hit) return;
        await node.fetchFullText(hit);
    }, [query]);

    const changeCoverage = useCallback(async (next: number) => {
        const catalog = catalogRef.current;
        const id = identity;
        if (!catalog || !id) return;
        setSeedReport(await reseed(catalog, id.id, next));
        setCoverage(next);
        setCatalogStats(catalog.stats());
    }, [identity]);

    const addDocument = useCallback(async (filename: string, raw: string) => {
        const catalog = catalogRef.current;
        if (!catalog) return;
        const text = normalizeUploadedText(raw);
        if (!text) throw new Error(`${filename} has no readable text`);
        const parsed = parseDocument(filename, text);
        if (!parsed.chunks.length) throw new Error(`${filename} has no readable text`);
        await catalog.ingestDoc(parsed, () => true);
        await catalog.reload();
        setCatalogStats(catalog.stats());
        setError('');
    }, []);

    const addFiles = useCallback(
        async (files: Array<{ name: string; text: string }>) => {
            for (const file of files) {
                await addDocument(file.name, file.text);
            }
        },
        [addDocument],
    );

    const loadLlm = useCallback(async () => {
        try {
            await llm.load();
        } catch {
            // The engine falls back to extractive answer generation automatically.
        }
    }, []);

    return {
        phase,
        error,
        identity,
        peers,
        activity,
        stats,
        radio,
        catalogStats,
        capabilities,
        coverage,
        seedReport,
        query,
        searching,
        llmStatus,
        answer,
        answerText,
        answering,
        search,
        openHit,
        changeCoverage,
        addDocument,
        addFiles,
        loadLlm,
        node: nodeRef.current,
    };
}
