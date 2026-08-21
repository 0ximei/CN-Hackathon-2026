import { useEffect, useRef, useState } from 'react';
import type { MeshState } from './useMesh';
import type { MeshHit } from '../protocol/MeshNode';
import { MODEL_ID } from '../llm/engine';

/* ------------------------------------------------------------------ *
 * Node panel — what this device holds, and how it got there
 * ------------------------------------------------------------------ */

export function NodePanel({
  state,
  onLoadShard,
  onLoadLlm,
}: {
  state: MeshState;
  onLoadShard: (shardId: number) => void;
  onLoadLlm: () => void;
}) {
  const { index, manifest, llmStatus, identity } = state;
  const busy = index.phase === 'indexing' || index.phase === 'downloading-model';

  return (
    <section className="panel">
      <header className="panel-head">
        <span className="panel-title">This node</span>
        <span className="tag mono">{identity.name}</span>
      </header>

      <div className="stack">
        <p className="lede">
          Each device stores one shard. Pick which slice of the corpus this node
          carries — the rest of the answer has to come from the mesh.
        </p>

        <div className="shard-row">
          {manifest?.shards.map((shard) => (
            <button
              key={shard.id}
              className={`shard-chip${index.shardId === shard.id ? ' is-active' : ''}`}
              onClick={() => onLoadShard(shard.id)}
              disabled={busy}
              aria-pressed={index.shardId === shard.id}
            >
              <span className="shard-chip-id mono">{shard.id}</span>
              <span className="shard-chip-n mono">{shard.chunks} psg</span>
            </button>
          ))}
          {!manifest && <span className="hint">loading corpus manifest…</span>}
        </div>

        {busy && (
          <div className="progress" role="progressbar" aria-valuenow={Math.round(index.progress * 100)}>
            <div className="progress-fill" style={{ width: `${index.progress * 100}%` }} />
          </div>
        )}

        <dl className="kv">
          <div>
            <dt>Index</dt>
            <dd className="mono">{index.detail || 'no shard loaded'}</dd>
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

        {llmStatus.phase !== 'ready' && llmStatus.phase !== 'unavailable' && (
          <button className="btn" onClick={onLoadLlm} disabled={llmStatus.phase === 'loading'}>
            {llmStatus.phase === 'loading' ? 'Downloading model…' : 'Load local model (~950 MB)'}
          </button>
        )}
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

  return (
    <section className="panel">
      <header className="panel-head">
        <span className="panel-title">Retrieved passages</span>
        <span className="tag mono">
          {local} local · {remote} from mesh
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
  return (
    <li className="result">
      <div className="result-head">
        <h3 className="result-title">{hit.section || hit.title}</h3>
        <span className={`origin${hit.local ? ' is-local' : ''}`}>
          <span className="mono">{hit.local ? 'this node' : hit.fromNodeName}</span>
          <span className="mono origin-hops">
            shard {hit.shardId} · {hit.hops}h
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
