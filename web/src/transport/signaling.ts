/**
 * Offline WebRTC signaling.
 *
 * There is no signaling server — that would defeat the point. Instead the SDP
 * is stripped to the handful of fields that actually matter and rebuilt on the
 * far side from a fixed template, then deflated and base64url'd. A full SDP is
 * 2-4KB and will not fit in a scannable QR code; the minified form is typically
 * 150-300 bytes and scans instantly.
 *
 * Only host candidates are gathered (no STUN), because both peers are on the
 * same LAN or hotspot and there is no internet to reach a STUN server anyway.
 */

export interface MiniSdp {
  /** 'o' = offer, 'a' = answer */
  t: 'o' | 'a';
  /** ICE username fragment */
  u: string;
  /** ICE password */
  p: string;
  /** DTLS fingerprint, sha-256, hex with colons stripped */
  f: string;
  /** DTLS role */
  s: string;
  /** Candidates as "foundation component protocol priority ip port type" */
  c: string[];
  /** Node identity, so the peer is addressable before any packet arrives */
  n: string;
}

const CANDIDATE_RE = /^a=candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)/;

export function minifySdp(sdp: string, type: 'o' | 'a', nodeUuid: string): MiniSdp {
  const line = (prefix: string) =>
    sdp
      .split('\r\n')
      .find((l) => l.startsWith(prefix))
      ?.slice(prefix.length) ?? '';

  const candidates: string[] = [];
  for (const l of sdp.split('\r\n')) {
    const m = CANDIDATE_RE.exec(l);
    // Host candidates only: srflx/relay require servers we do not have offline.
    if (m && m[7] === 'host') candidates.push(`${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]} ${m[6]}`);
  }

  return {
    t: type,
    u: line('a=ice-ufrag:'),
    p: line('a=ice-pwd:'),
    f: line('a=fingerprint:sha-256 ').replace(/:/g, ''),
    s: line('a=setup:'),
    c: candidates,
    n: nodeUuid,
  };
}

export function expandSdp(mini: MiniSdp): string {
  const fingerprint = (mini.f.match(/.{2}/g) ?? []).join(':').toUpperCase();
  const candidates = mini.c
    .map((c) => {
      const [foundation, component, protocol, priority, ip, port] = c.split(' ');
      return `a=candidate:${foundation} ${component} ${protocol} ${priority} ${ip} ${port} typ host`;
    })
    .join('\r\n');

  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${mini.u}`,
    `a=ice-pwd:${mini.p}`,
    `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${mini.s}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    candidates,
    '',
  ]
    .filter((l) => l !== undefined)
    .join('\r\n');
}

/* ---- compact text encoding, so the payload fits a QR code ---- */

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function deflate(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

/** Encodes a session description into a QR-sized token. */
export async function encodeToken(mini: MiniSdp): Promise<string> {
  return toBase64Url(await deflate(JSON.stringify(mini)));
}

export async function decodeToken(token: string): Promise<MiniSdp> {
  const json = await inflate(fromBase64Url(token.trim()));
  const mini = JSON.parse(json) as MiniSdp;
  if (!mini.u || !mini.p || !mini.f) throw new Error('malformed pairing token');
  return mini;
}
