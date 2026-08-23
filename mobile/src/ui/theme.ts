/* Hallmark · theme: custom · scope: colour system + light mode
 * tone: utilitarian-technical · paper: dual (cream #f6f2ec / warm-dark #131117)
 * accents: five-hue semantic index — violet 265 · teal 195 · plum 320 · green 150 · blue 230
 * pre-emit critique: P5 H5 E5 S5 R4 V5
 *
 * The colour idea is borrowed from Headspace, but only the part worth
 * borrowing: hue as an *index* rather than as decoration. Each tab owns one,
 * so the app tells you where you are before you have read a word. What is not
 * borrowed is the pastel wash — this is an instrument used in an emergency,
 * and every colour here has to earn its contrast.
 *
 * Two rules hold the system together:
 *
 *   1. The five tab hues all sit outside 10–60°, the amber/red band. Warn and
 *      danger therefore cannot be mistaken for "you are on the Files tab".
 *   2. Trust states do NOT use the tab accent. A peer that is trusted must be
 *      the same colour on every tab, or the badge is reporting the navigation
 *      rather than the peer.
 */
import type { TextStyle } from 'react-native';
import { Easing } from 'react-native';

export type Scheme = 'light' | 'dark';
/** `null` means "follow the system" — the default. */
export type SchemePreference = Scheme | null;

export type TabId = 'ask' | 'map' | 'files' | 'node' | 'log';

export interface Palette {
    scheme: Scheme;

    /* surfaces, lightest-carrying-content to most-recessed */
    bg: string;
    panel: string;
    panelAlt: string;
    /** Quiet separator. The surface step does most of the work; this trims it. */
    hairline: string;
    /** Loud edge, for the surfaces that are making a point. */
    border: string;

    text: string;
    dim: string;
    faint: string;

    /** Ink that sits ON a filled accent. Flips with the paper. */
    onAccent: string;

    /* Semantic, and deliberately not part of the tab rotation. */
    warn: string;
    danger: string;
    positive: string;
    info: string;

    /** One colour per packet type, for the wire log and the topology view. */
    wire: Record<string, string>;
    /** One per activity kind, for the leading label in the log. */
    kind: Record<string, string>;
    /** One per trust state, used everywhere a peer is named. */
    trust: Record<string, string>;

    mono: string;
}

/**
 * The five tab hues, in both papers.
 *
 * A hue bright enough to read on near-black is washed out on cream, so each
 * one is authored twice rather than derived — a single value tuned for one
 * paper always fails on the other.
 */
export const tabAccent: Record<TabId, Record<Scheme, string>> = {
    ask: { dark: '#a78bfa', light: '#6440c9' },   // violet 265°
    map: { dark: '#3ec9e0', light: '#0e6f88' },   // teal   195°
    files: { dark: '#e879c7', light: '#a8317f' }, // plum   320°
    node: { dark: '#3ddc97', light: '#0f7a52' },  // green  150°
    log: { dark: '#7aa2f7', light: '#3355c4' },   // blue   230°
};

/** The hue used before a tab is in play — onboarding, boot, failure. */
export const seedAccent: Record<Scheme, string> = tabAccent.ask;

const wireDark: Record<string, string> = {
    HELLO: '#94a3b8',
    QUERY: '#7aa2f7',
    RESULT: '#3ddc97',
    DOC_REQ: '#e879c7',
    DOC_RES: '#e879c7',
    ANNOUNCE: '#fbbf24',
    CATALOG_REQ: '#fbbf24',
    CATALOG_RES: '#fbbf24',
    IDENT_REQ: '#fb90b8',
    IDENT_RES: '#fb90b8',
    BODY: '#3ddc97',
    OUTBOX: '#94a3b8',
    RADIO: '#3ec9e0',
    FRAME: '#f87171',
};

const wireLight: Record<string, string> = {
    HELLO: '#4a5566',
    QUERY: '#3355c4',
    RESULT: '#0f7a52',
    DOC_REQ: '#a8317f',
    DOC_RES: '#a8317f',
    ANNOUNCE: '#8a5a00',
    CATALOG_REQ: '#8a5a00',
    CATALOG_RES: '#8a5a00',
    IDENT_REQ: '#b0286b',
    IDENT_RES: '#b0286b',
    BODY: '#0f7a52',
    OUTBOX: '#4a5566',
    RADIO: '#0e6f88',
    FRAME: '#b3261e',
};

const dark: Palette = {
    scheme: 'dark',
    bg: '#131117',
    panel: '#1e1b24',
    panelAlt: '#292430',
    hairline: '#3a3442',
    border: '#544c63',
    text: '#f6f4f8',
    dim: '#c3bccd',
    faint: '#8f8899',
    onAccent: '#131117',
    warn: '#fbbf24',
    danger: '#f87171',
    positive: '#3ddc97',
    info: '#7aa2f7',
    wire: wireDark,
    kind: {
        sent: '#7aa2f7',
        received: '#a78bfa',
        forwarded: '#fbbf24',
        dropped: '#f87171',
        replicated: '#3ddc97',
        evicted: '#fb923c',
        radio: '#8f8899',
    },
    trust: {
        unknown: '#8f8899',
        pending: '#fbbf24',
        verified: '#7aa2f7',
        trusted: '#3ddc97',
        mismatch: '#fbbf24',
        failed: '#f87171',
    },
    mono: 'monospace',
};

const light: Palette = {
    scheme: 'light',
    // Warm cream rather than white: a pure-white ground under a dense
    // instrument glares, and this one gets read outdoors.
    bg: '#f6f2ec',
    panel: '#fffefb',
    panelAlt: '#ece5da',
    hairline: '#e0d8cb',
    border: '#c3b8a7',
    text: '#1c1a24',
    dim: '#544f5e',
    faint: '#6b6577',
    onAccent: '#ffffff',
    warn: '#8a5a00',
    danger: '#b3261e',
    positive: '#0f7a52',
    info: '#3355c4',
    wire: wireLight,
    kind: {
        sent: '#3355c4',
        received: '#6440c9',
        forwarded: '#8a5a00',
        dropped: '#b3261e',
        replicated: '#0f7a52',
        evicted: '#a24a12',
        radio: '#6b6577',
    },
    trust: {
        unknown: '#6b6577',
        pending: '#8a5a00',
        verified: '#3355c4',
        trusted: '#0f7a52',
        mismatch: '#8a5a00',
        failed: '#b3261e',
    },
    mono: 'monospace',
};

export const palettes: Record<Scheme, Palette> = { light, dark };

/** 4pt scale. Every margin, padding and gap in the app comes from here. */
export const space = {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    xxl: 28,
    huge: 40,
} as const;

/**
 * Four radii doing four different jobs, where there used to be one doing all of
 * them. A card, the control inside it and the bar inside that cannot all be 16
 * and still read as nested.
 */
export const radius = {
    sm: 6,
    control: 12,
    card: 14,
    pill: 999,
} as const;

/**
 * Ten roles, down from eleven ad-hoc sizes.
 *
 * Monospace is reserved for things that are genuinely tabular — hashes, node
 * ids, byte counts, the wire log — and every one of those carries
 * `tabular-nums` so the digits stop shifting as they tick. Explanatory prose is
 * sans; it used to be 11px monospace, which is a paragraph set in a face meant
 * for columns of hex.
 */
export const typography = {
    display: { fontSize: 27, lineHeight: 33, fontWeight: '700', letterSpacing: -0.5 },
    title: { fontSize: 20, lineHeight: 25, fontWeight: '700', letterSpacing: -0.3 },
    heading: { fontSize: 15, lineHeight: 20, fontWeight: '600', letterSpacing: -0.1 },
    body: { fontSize: 14, lineHeight: 21 },
    bodySm: { fontSize: 13, lineHeight: 19 },
    label: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
    micro: { fontSize: 11, lineHeight: 16 },

    mono: { fontSize: 12, lineHeight: 16, fontFamily: 'monospace', fontVariant: ['tabular-nums'] },
    monoSm: { fontSize: 10, lineHeight: 14, fontFamily: 'monospace', fontVariant: ['tabular-nums'] },
    /** The wire log and the graph's sub-labels — the densest data on screen. */
    monoNano: { fontSize: 9, lineHeight: 13, fontFamily: 'monospace', fontVariant: ['tabular-nums'] },

    /**
     * Two sizes for the one job no other type role does: a string one person
     * reads off a screen while another checks it against theirs. A fingerprint
     * and a safety number are not decoration and not dense data — they have to
     * survive being held at arm's length in bad light.
     */
    readAloud: { fontSize: 15, lineHeight: 21, fontFamily: 'monospace', fontVariant: ['tabular-nums'] },
    readAloudLg: { fontSize: 17, lineHeight: 26, fontFamily: 'monospace', fontVariant: ['tabular-nums'] },
} satisfies Record<string, TextStyle>;

/**
 * Three durations and three easings, so nothing reaches for the RN default
 * `Easing.ease` — the mobile equivalent of CSS `ease`, and the one curve every
 * generated interface uses.
 *
 * No overshoot anywhere. A bouncing progress bar on a screen reporting whether
 * a passage still has a live copy is a lie about how sure the app is.
 */
export const motion = {
    fast: 120,
    base: 180,
    slow: 280,
    ease: Easing.bezier(0.2, 0, 0, 1),
    easeIn: Easing.bezier(0.4, 0, 1, 1),
    easeInOut: Easing.bezier(0.4, 0, 0.2, 1),
} as const;

/**
 * The floor for anything tappable, per the platform guidance both vendors
 * publish. Controls smaller than this reach it with `hitSlop` rather than by
 * growing — a chip should look like a chip.
 */
export const TAP_TARGET = 44;

/** Bytes in the shortest form that is still honest about magnitude. */
export function bytes(n: number): string {
    if (n < 1024) return `${Math.round(n)} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const trustLabel: Record<string, string> = {
    unknown: 'unverified',
    pending: 'challenged',
    verified: 'key proven',
    trusted: 'verified in person',
    mismatch: 'key changed',
    failed: 'failed',
};
