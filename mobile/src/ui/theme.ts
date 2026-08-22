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

export const kindColor: Record<string, string> = {
  sent: theme.link,
  recv: theme.accent,
  forward: theme.warn,
  drop: theme.danger,
  radio: theme.faint,
};
