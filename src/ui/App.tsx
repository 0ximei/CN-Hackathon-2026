import { useCallback, useState, type FormEvent } from 'react';
import { useMesh } from './useMesh';
import { MeshGraph } from './MeshGraph';
import {
  AnswerPanel,
  DevPanel,
  LibraryPanel,
  LlmButton,
  PeerConnect,
  PeersPanel,
  ResultsList,
  StoragePanel,
  WireLog,
} from './Panels';
import type { TransportKind } from '../transport/Transport';

const EXAMPLES = [
  'how long do I cool a burn',
  'someone stopped shivering in the cold',
  'what do I do for a snake bite',
  'is the water safe to drink',
];

export function App() {
  const [transportKind, setTransportKind] = useState<TransportKind>('broadcast');
  const { state, search, addFiles, addSample, forgetDocument, setBudget, loadLlm, setDev } =
    useMesh(transportKind);
  const [input, setInput] = useState('');

  const onSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      void search(input);
    },
    [input, search],
  );

  const patchDev = useCallback(
    (patch: Partial<typeof state.dev>) => setDev((d) => ({ ...d, ...patch })),
    [setDev],
  );

  const online = state.peers.length;
  // What the mesh can *find*, which is the union of every catalog rather than a
  // sum of disjoint shards — peers largely know the same passages now.
  const reachable = Math.max(state.index.known, ...state.peers.map((p) => p.known), 0);
  const ready = state.index.phase === 'ready';
  const empty = ready && state.index.known === 0;

  return (
    <div className="shell">
      <header className="masthead">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">MeshNet</span>
        </div>

        <div className="masthead-meta">
          <span className="tag mono">
            {online} peer{online === 1 ? '' : 's'}
          </span>
          <span className="tag mono">{reachable} passages reachable</span>
          <div className="seg" role="group" aria-label="Transport">
            {(['broadcast', 'webrtc'] as const).map((kind) => (
              <button
                key={kind}
                className={`seg-btn${transportKind === kind ? ' is-active' : ''}`}
                onClick={() => setTransportKind(kind)}
                aria-pressed={transportKind === kind}
              >
                {kind === 'broadcast' ? 'Local tabs' : 'Wi-Fi / WebRTC'}
              </button>
            ))}
          </div>
        </div>
      </header>

      {state.error && (
        <p className="banner" role="alert">
          {state.error}
        </p>
      )}

      <main className="layout">
        {/* The map is the organising element: the query's path through the
            network is the primary thing this interface has to show. */}
        <section className="map">
          <div className="map-head">
            <h1 className="map-title">Query floods out. Answers route back.</h1>
            <p className="map-sub">
              No internet, no server. Upload a document and it replicates itself
              across the mesh — metadata everywhere, full text where it fits.
            </p>
          </div>

          <MeshGraph
            identity={state.identity}
            selfStored={state.index.stored}
            peers={state.peers}
            routes={state.routes}
            activity={state.activity}
            respondedNodeIds={state.query?.respondedNodeIds ?? []}
          />

          <ul className="legend mono">
            <li><i style={{ background: 'var(--wire-hello)' }} />hello</li>
            <li><i style={{ background: 'var(--wire-query)' }} />query</li>
            <li><i style={{ background: 'var(--wire-result)' }} />result</li>
            <li><i style={{ background: 'var(--wire-doc)' }} />passage</li>
            <li><i style={{ background: 'var(--wire-announce)' }} />announce</li>
            <li><i style={{ background: 'var(--wire-drop)' }} />dropped</li>
          </ul>

          {online === 0 && (
            <p className="map-empty">
              {transportKind === 'broadcast'
                ? 'Open this page in another tab to bring a second node online.'
                : 'Pair a device below to form your first link.'}
            </p>
          )}
        </section>

        <div className="console">
          <form className="ask" onSubmit={onSubmit}>
            <label className="ask-label" htmlFor="q">
              Ask the mesh
            </label>
            <div className="ask-row">
              <input
                id="q"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  empty ? 'upload a document first' : ready ? 'how do I treat a burn' : 'starting…'
                }
                autoComplete="off"
                disabled={!ready || empty}
              />
              <button
                className="btn btn-primary"
                disabled={!ready || empty || state.searching || !input.trim()}
              >
                {state.searching ? 'Searching…' : 'Search'}
              </button>
            </div>
            <div className="examples">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  className="example"
                  onClick={() => {
                    setInput(ex);
                    void search(ex);
                  }}
                  disabled={!ready || empty || state.searching}
                >
                  {ex}
                </button>
              ))}
            </div>
          </form>

          <AnswerPanel state={state} />
          <ResultsList state={state} />
          <LibraryPanel
            state={state}
            onAddFiles={(files) => void addFiles(files)}
            onAddSample={(sample) => void addSample(sample)}
            onForget={(docKey) => void forgetDocument(docKey)}
          />
          <StoragePanel state={state} onSetBudget={(b) => void setBudget(b)} />
          <LlmButton state={state} onLoadLlm={loadLlm} />
          <PeersPanel state={state} />
          <PeerConnect state={state} />
          <DevPanel state={state} onChange={patchDev} />
          <WireLog state={state} />
        </div>
      </main>
    </div>
  );
}
