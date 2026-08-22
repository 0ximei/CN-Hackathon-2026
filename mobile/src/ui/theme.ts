export const theme = {
  bg: '#0b0f14',
  panel: '#131a23',
  panelAlt: '#18212c',
  border: '#233040',
  text: '#e6edf5',
  dim: '#8fa3ba',
  faint: '#5b6c80',
  accent: '#4ade80',
  accentDim: '#166534',
  warn: '#fbbf24',
  danger: '#f87171',
  link: '#60a5fa',
  mono: 'monospace' as const,
};

/**
 * One colour per packet type, shared by the wire log and the topology view.
 *
 * The two are showing the same events — a line in the log and a dot crossing an
 * edge are the same packet — so they have to agree, or the map stops being a
 * legend for the log.
 */
export const wireColor: Record<string, string> = {
  HELLO: '#64748b',
  QUERY: '#60a5fa',
  RESULT: '#4ade80',
  DOC_REQ: '#c084fc',
  DOC_RES: '#c084fc',
  ANNOUNCE: '#fbbf24',
  CATALOG_REQ: '#fbbf24',
  CATALOG_RES: '#fbbf24',
  IDENT_REQ: '#f472b6',
  IDENT_RES: '#f472b6',
  BODY: '#4ade80',
  OUTBOX: '#94a3b8',
  RADIO: '#5b6c80',
  FRAME: '#f87171',
};

/** Colour per activity kind, for the leading label in the log. */
export const kindColor: Record<string, string> = {
  sent: theme.link,
  received: theme.accent,
  forwarded: theme.warn,
  dropped: theme.danger,
  replicated: '#4ade80',
  evicted: '#fb923c',
  radio: theme.faint,
};

/** Colour per trust state, used everywhere a peer is named. */
export const trustColor: Record<string, string> = {
  unknown: theme.faint,
  pending: theme.warn,
  verified: theme.link,
  trusted: theme.accent,
  mismatch: theme.warn,
  failed: theme.danger,
};

export const trustLabel: Record<string, string> = {
  unknown: 'unverified',
  pending: 'challenged',
  verified: 'key proven',
  trusted: 'verified in person',
  mismatch: 'key changed',
  failed: 'failed',
};

/** Bytes in the shortest form that is still honest about magnitude. */
export function bytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
