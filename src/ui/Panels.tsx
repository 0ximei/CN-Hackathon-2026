import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { MeshState, SampleDoc } from './useMesh';
import type { MeshHit } from '../protocol/MeshNode';
import { MODEL_ID } from '../llm/engine';
import { MAX_BODY_REPLICAS } from '../replication/policy';

/** Bytes in the shortest form that is still honest about magnitude. */
function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ *
 * Node panel — what this device holds, and how it got there
 * ------------------------------------------------------------------ */

export function LibraryPanel({
  state,
  onAddFiles,
  onAddSample,
  onForget,
}: {
  state: MeshState;
  onAddFiles: (files: File[]) => void;
  onAddSample: (sample: SampleDoc) => void;
  onForget: (docKey: number) => void;
}) {
  const { documents, samples, upload, index, identity } = state;
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = upload.busy || index.phase === 'indexing';

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files].filter((f) => /\.(txt|md|markdown|text)$/i.test(f.name));
    if (files.length) onAddFiles(files);
  };

  // Match on title, not filename: a document's `source` is overridden by the
  // `source:` line inside the markdown, so it is not the file it came from.
  const untried = samples?.samples.filter(
    (sample) => !documents.some((d) => d.title === sample.title),
  );

  return (
    <section className="panel">
      <header className="panel-head">
        <span className="panel-title">Library</span>
        <span className="tag mono">{identity.name}</span>
      </header>

      <div className="stack">
        <p className="lede">
          Nothing is preloaded. Upload a document and it enters the mesh here,
          then spreads by itself — metadata to everyone, full text to the nodes
          the policy picks.
        </p>

        <div
          className={`drop${dragging ? ' is-over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".txt,.md,.markdown,.text"
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              if (files.length) onAddFiles(files);
              e.target.value = '';
            }}
          />
          <p className="drop-text">
            Drop <span className="mono">.txt</span> or <span className="mono">.md</span> files here
          </p>
          <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? 'Indexing…' : 'Choose files'}
          </button>
        </div>

        {busy && (
          <div className="stack-tight">
            <div
              className="progress"
              role="progressbar"
              aria-valuenow={upload.total ? Math.round((upload.done / upload.total) * 100) : 0}
            >
              <div
                className="progress-fill"
                style={{ width: `${upload.total ? (upload.done / upload.total) * 100 : 0}%` }}
              />
            </div>
            <p className="hint mono">
              {upload.label}
              {upload.total ? ` — ${upload.done}/${upload.total} passages embedded` : ''}
            </p>
          </div>
        )}

        {untried?.length ? (
          <div className="field">
            <span className="field-label">
              Sample documents <span className="hint">uploaded exactly like your own</span>
            </span>
            <div className="chip-row">
              {untried.map((sample) => (
                <button
                  key={sample.file}
                  className="shard-chip"
                  onClick={() => onAddSample(sample)}
                  disabled={busy}
                >
                  <span className="shard-chip-id mono">{sample.title}</span>
                  <span className="shard-chip-n mono">{sample.words} words</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {documents.length > 0 && (
          <ul className="docs">
            {documents.map((doc) => (
              <DocRow key={doc.docKey} doc={doc} selfId={identity.id} onForget={onForget} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * One document, with the thing that actually matters: how many live copies of
 * its text exist versus how many the policy wants.
 */
function DocRow({
  doc,
  selfId,
  onForget,
}: {
  doc: MeshState['documents'][number];
  selfId: number;
  onForget: (docKey: number) => void;
}) {
  const replicas = doc.meanReplicas;
  const short = replicas + 0.001 < doc.desired;
  const atRisk = replicas <= 1;

  return (
    <li className="doc">
      <div className="doc-head">
        <h3 className="doc-title">{doc.title}</h3>
        <span
          className={`tag mono${atRisk ? ' is-warn' : short ? ' is-pending' : ' is-ok'}`}
          title={`${replicas.toFixed(1)} live copies of each passage, target ${doc.desired}`}
        >
          {replicas.toFixed(1)}/{doc.desired} copies
        </span>
      </div>

      <div className="doc-bar" aria-hidden="true">
        {Array.from({ length: MAX_BODY_REPLICAS }, (_, i) => (
          <i
            key={i}
            className={
              i < Math.round(replicas) ? 'is-held' : i < doc.desired ? 'is-wanted' : 'is-idle'
            }
          />
        ))}
      </div>

      <div className="doc-meta mono">
        <span>{doc.chunkCount} passages</span>
        <span>{bytes(doc.bytes)}</span>
        <span>{doc.storedHere ? `${doc.storedHere} stored here` : 'metadata only'}</span>
        {doc.hits > 0 && <span>{doc.hits} hits</span>}
        {doc.originId === selfId && <span className="doc-origin">uploaded here</span>}
        <button className="link-btn" onClick={() => onForget(doc.docKey)}>
          forget
        </button>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * Storage — the two tiers, side by side, in real bytes
 * ------------------------------------------------------------------ */

const BUDGETS: { label: string; bytes: number }[] = [
  { label: '4 KB', bytes: 4 * 1024 },
  { label: '64 KB', bytes: 64 * 1024 },
  { label: '1 MB', bytes: 1024 * 1024 },
  { label: '8 MB', bytes: 8 * 1024 * 1024 },
];

export function StoragePanel({
  state,
  onSetBudget,
}: {
  state: MeshState;
  onSetBudget: (bytes: number) => void;
}) {
  const { replication, index, llmStatus, peers } = state;
  const r = replication;
  const used = r ? r.metaBytes + r.bodyBytes : 0;
  const pct = r && r.budgetBytes ? Math.min(100, (used / r.budgetBytes) * 100) : 0;
  const metaShare = used ? ((r!.metaBytes / used) * 100).toFixed(0) : '0';

  return (
    <section className="panel">
      <header className="panel-head">
        <span className="panel-title">This node</span>
        {r?.underPressure && <span className="tag mono is-warn">over budget</span>}
      </header>

      <div className="stack">
        <p className="lede">
          Metadata is what makes a passage findable; the body is what makes it
          readable. Holding the first everywhere is cheap, so this node knows
          about far more than it stores.
        </p>

        <div className="tier">
          <div className="tier-row">
            <span className="tier-label mono">knows</span>
            <span className="tier-bar">
              <i style={{ width: '100%' }} className="is-meta" />
            </span>
            <span className="tier-value mono">
              {index.known} psg · {r ? bytes(r.metaBytes) : '—'}
            </span>
          </div>
          <div className="tier-row">
            <span className="tier-label mono">stores</span>
            <span className="tier-bar">
              <i
                className="is-body"
                style={{ width: `${index.known ? (index.stored / index.known) * 100 : 0}%` }}
              />
            </span>
            <span className="tier-value mono">
              {index.stored} psg · {r ? bytes(r.bodyBytes) : '—'}
            </span>
          </div>
        </div>

        {r && (
          <>
            <div className="progress" role="progressbar" aria-valuenow={Math.round(pct)}>
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <p className="hint mono">
              {bytes(used)} of {bytes(r.budgetBytes)} budget · metadata is {metaShare}% of it
            </p>
          </>
        )}

        <dl className="kv">
          <div>
            <dt>Replication</dt>
            <dd className="mono">
              {r
                ? `${r.pulls} pulled · ${r.evictions} evicted · ${r.underReplicated} below target`
                : 'waiting for first pass'}
            </dd>
          </div>
          <div>
            <dt>Index</dt>
            <dd className="mono">{index.detail || 'empty'}</dd>
          </div>
          <div>
            <dt>Embedder</dt>
            <dd className="mono">MiniLM-L6 · 384d · {index.backend}</dd>
          </div>
          <div>
            <dt>Generator</dt>
            <dd className="mono">
              {llmStatus.phase === 'ready'
                ? `${MODEL_ID.replace('-MLC', '')} ready`
                : llmStatus.phase === 'loading'
                  ? `${Math.round(llmStatus.progress * 100)}% · ${llmStatus.detail}`
                  : llmStatus.phase === 'unavailable'
                    ? 'no WebGPU · extractive mode'
                    : 'not loaded · extractive mode'}
            </dd>
          </div>
        </dl>

        <div className="field">
          <span className="field-label">
            Storage budget <span className="hint">shrink it to force this node to shed bodies</span>
          </span>
          <div className="chip-row">
            {BUDGETS.map((b) => (
              <button
                key={b.bytes}
                className={`shard-chip${r && r.budgetBytes === b.bytes ? ' is-active' : ''}`}
                onClick={() => onSetBudget(b.bytes)}
              >
                <span className="shard-chip-id mono">{b.label}</span>
              </button>
            ))}
          </div>
        </div>

        {r && r.atRisk > 0 && peers.length > 0 && (
          <p className="hint is-warn-text">
            {r.atRisk} passage{r.atRisk === 1 ? '' : 's'} have only one live copy.
          </p>
        )}
      </div>
    </section>
  );
}

export function LlmButton({ state, onLoadLlm }: { state: MeshState; onLoadLlm: () => void }) {
  const { llmStatus } = state;
  if (llmStatus.phase === 'ready' || llmStatus.phase === 'unavailable') return null;
  return (
    <button className="btn" onClick={onLoadLlm} disabled={llmStatus.phase === 'loading'}>
      {llmStatus.phase === 'loading' ? 'Downloading model…' : 'Load local model (~950 MB)'}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Peers — capacity and observed reliability, the placement inputs
 * ------------------------------------------------------------------ */

export function PeersPanel({ state }: { state: MeshState }) {
  const { peers } = state;
  if (!peers.length) return null;

  return (
    <section className="panel">
      <header className="panel-head">
        <span className="panel-title">Peers</span>
        <span className="tag mono">placement inputs</span>
      </header>
      <div className="stack">
        <p className="lede">
          Reliability is measured here, never reported by the peer — a node
          claiming to be dependable is not evidence of anything.
        </p>
        <ul className="peers">
          {peers.map((p) => (
            <li key={p.nodeId} className="peer">
              <span className="peer-name mono">{p.name}</span>
              <span className="peer-bar" title={`reliability ${(p.reliability * 100).toFixed(0)}%`}>
                <i style={{ width: `${p.reliability * 100}%` }} />
              </span>
              <span className="peer-meta mono">
                {p.stored}/{p.known} psg · {bytes(p.freeBytes)} free · {p.hops}h
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Answer — grounded, cited, and honest about which mode produced it
 * ------------------------------------------------------------------ */

export function AnswerPanel({ state }: { state: MeshState }) {
  const { answer, answerText, answering, query, searching } = state;

  if (searching) {
    return (
      <section className="panel answer">
        <header className="panel-head">
          <span className="panel-title">Answer</span>
          <span className="tag mono">flooding query</span>
        </header>
        <div className="stack">
          <p className="hint">
            Waiting on the mesh — replies are collected until every known peer
            has answered, or 5s, whichever comes first.
          </p>
        </div>
      </section>
    );
  }

  if (!query) return null;
  const text = answerText || answer?.text;
  if (!text && !answering) return null;

  return (
    <section className="panel answer">
      <header className="panel-head">
        <span className="panel-title">Answer</span>
        <span className="tag mono">
          {answer?.mode === 'generated' ? 'on-device LLM' : answering ? 'generating' : 'extractive'}
        </span>
      </header>
      <div className="stack">
        <p className="answer-body">
          {text}
          {answering && <span className="caret" aria-hidden="true" />}
        </p>
        {answer?.passages.length ? (
          <ol className="citations">
            {answer.passages.map((p, i) => (
              <li key={p.hit.docId}>
                <span className="mono citation-n">[{i + 1}]</span>
                <span>
                  {p.hit.title} — {p.hit.section}
                </span>
                <span className="tag mono">
                  {p.hit.local ? 'local' : `${p.hit.fromNodeName} · ${p.hit.hops}h`}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
        <p className="disclaimer">
          Reference material for emergencies without connectivity. Not a substitute
          for professional medical care.
        </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Results — every hit says which node it came from and how far away
 * ------------------------------------------------------------------ */

export function ResultsList({ state }: { state: MeshState }) {
  const { query } = state;
  if (!query || !query.hits.length) return null;

  const local = query.hits.filter((h) => h.local).length;
  const remote = query.hits.length - local;
  const fetched = query.hits.filter((h) => !h.storedHere && h.text).length;

  return (
    <section className="panel">
      <header className="panel-head">
        <span className="panel-title">Retrieved passages</span>
        <span className="tag mono">
          {local} local · {remote} from mesh
          {fetched ? ` · ${fetched} body fetched` : ''}
        </span>
      </header>
      <ul className="results">
        {query.hits.map((hit) => (
          <ResultRow key={hit.docId} hit={hit} />
        ))}
      </ul>
    </section>
  );
}

function ResultRow({ hit }: { hit: MeshHit }) {
  // "found by" and "stored on" are now different facts. A node can match a
  // passage from metadata it holds without holding the passage, so saying only
  // where the hit came from would misrepresent where the text lives.
  const tier = hit.storedHere ? 'stored here' : 'body fetched';

  return (
    <li className="result">
      <div className="result-head">
        <h3 className="result-title">{hit.section || hit.title}</h3>
        <span className={`origin${hit.local ? ' is-local' : ''}`}>
          <span className="mono">{hit.local ? 'this node' : hit.fromNodeName}</span>
          <span className="mono origin-hops">
            {tier} · {hit.hops}h
          </span>
        </span>
      </div>
      <p className="result-text">{hit.text ?? hit.snippet}</p>
      <div className="result-meta mono">
        <span>{hit.title}</span>
        <span className="score" title="cosine similarity">
          {hit.score.toFixed(3)}
        </span>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * Wire log — the packet trace, so the routing is legible not magic
 * ------------------------------------------------------------------ */

export function WireLog({ state }: { state: MeshState }) {
  const { activity, node } = state;
  const stats = node?.router.stats;

  return (
    <section className="panel">
      <header className="panel-head">
        <span className="panel-title">Wire log</span>
        {stats && (
          <span className="tag mono">
            {stats.sent}↑ {stats.received}↓ {stats.forwarded}⇄ {stats.duplicates} dup
          </span>
        )}
      </header>
      <ul className="wire">
        {activity.slice(0, 14).map((ev, i) => (
          <li key={`${ev.at}-${i}`} className={`wire-row is-${ev.kind}`}>
            <span className="mono wire-kind">{ev.kind}</span>
            <span className="mono wire-type" data-type={ev.type}>
              {ev.type}
            </span>
            <span className="mono wire-peer">{ev.peer}</span>
            {ev.reason && <span className="mono wire-reason">{ev.reason}</span>}
            {ev.detail && <span className="mono wire-detail">{ev.detail}</span>}
          </li>
        ))}
        {!activity.length && <li className="hint">no traffic yet</li>}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Dev controls — break the network on purpose, on stage
 * ------------------------------------------------------------------ */

export function DevPanel({
  state,
  onChange,
}: {
  state: MeshState;
  onChange: (patch: Partial<MeshState['dev']>) => void;
}) {
  const { dev, peers, outbox } = state;

  const toggleLink = (peerId: string) => {
    const cut = dev.cutLinks.includes(peerId)
      ? dev.cutLinks.filter((p) => p !== peerId)
      : [...dev.cutLinks, peerId];
    onChange({ cutLinks: cut });
  };

  return (
    <section className="panel">
      <header className="panel-head">
        <span className="panel-title">Network controls</span>
        {outbox > 0 && <span className="tag mono is-warn">{outbox} held</span>}
      </header>
      <div className="stack">
        <label className="field">
          <span className="field-label">
            Hop limit <span className="mono">TTL {dev.ttl}</span>
          </span>
          <input
            type="range"
            min={1}
            max={8}
            value={dev.ttl}
            onChange={(e) => onChange({ ttl: Number(e.target.value) })}
          />
        </label>

        <label className="field">
          <span className="field-label">
            Packet loss <span className="mono">{Math.round(dev.packetLoss * 100)}%</span>
          </span>
          <input
            type="range"
            min={0}
            max={60}
            value={dev.packetLoss * 100}
            onChange={(e) => onChange({ packetLoss: Number(e.target.value) / 100 })}
          />
        </label>

        <div className="field">
          <span className="field-label">
            Cut a link <span className="hint">forces multi-hop routing</span>
          </span>
          <div className="shard-row">
            {peers.map((peer) => {
              const cut = dev.cutLinks.includes(String(peer.nodeId));
              return (
                <button
                  key={peer.nodeId}
                  className={`shard-chip${cut ? ' is-cut' : ''}`}
                  onClick={() => toggleLink(String(peer.nodeId))}
                  aria-pressed={cut}
                >
                  <span className="shard-chip-id mono">{peer.name}</span>
                  <span className="shard-chip-n mono">{cut ? 'severed' : 'up'}</span>
                </button>
              );
            })}
            {!peers.length && <span className="hint">no peers to cut yet</span>}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Pairing — offline WebRTC handshake over copy/paste tokens
 * ------------------------------------------------------------------ */

export function PeerConnect({ state }: { state: MeshState }) {
  const [invite, setInvite] = useState('');
  const [incoming, setIncoming] = useState('');
  const [answerToken, setAnswerToken] = useState('');
  const [note, setNote] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const transport = state.node?.transport;
  const isWebRtc = transport?.kind === 'webrtc';

  useEffect(() => {
    const token = answerToken || invite;
    if (!token || !canvasRef.current) return;
    void (async () => {
      const QRCode = (await import('qrcode')).default;
      await QRCode.toCanvas(canvasRef.current, token, {
        width: 200,
        margin: 1,
        color: { dark: '#0f1a16', light: '#7ee8a8' },
      });
    })();
  }, [invite, answerToken]);

  if (!isWebRtc) return null;
  const rtc = transport as import('../transport/WebRTCTransport').WebRTCTransport;

  const run = async (fn: () => Promise<void>) => {
    setNote('');
    try {
      await fn();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="panel">
      <header className="panel-head">
        <span className="panel-title">Pair a device</span>
        <span className="tag mono">no server</span>
      </header>
      <div className="stack">
        <p className="lede">
          Pair only with your neighbours. Routing does the rest — A pairs with B,
          B pairs with C, and A still reaches C through B.
        </p>

        <div className="pair-row">
          <button
            className="btn btn-primary"
            onClick={() => run(async () => setInvite(await rtc.createInvite()))}
          >
            Create invite
          </button>
          <button
            className="btn"
            onClick={() =>
              run(async () => {
                if (!incoming) throw new Error('paste the invite you received first');
                setAnswerToken(await rtc.acceptInvite(incoming));
              })
            }
          >
            Accept invite
          </button>
          <button
            className="btn"
            onClick={() =>
              run(async () => {
                if (!invite) throw new Error('create an invite first');
                await rtc.completeInvite(invite, incoming);
                setNote('link established');
              })
            }
          >
            Complete
          </button>
        </div>

        {(invite || answerToken) && (
          <div className="pair-token">
            <canvas ref={canvasRef} aria-label="pairing QR code" />
            <textarea readOnly value={answerToken || invite} rows={3} className="mono" />
          </div>
        )}

        <label className="field">
          <span className="field-label">Paste a token from the other device</span>
          <textarea
            value={incoming}
            onChange={(e) => setIncoming(e.target.value)}
            rows={3}
            className="mono"
            placeholder="paste invite or answer token"
          />
        </label>

        {note && <p className="hint">{note}</p>}
      </div>
    </section>
  );
}
