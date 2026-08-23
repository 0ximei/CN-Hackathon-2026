import { StyleSheet } from 'react-native';
import { type Palette, radius, space, typography } from '../theme';

/**
 * The stylesheet, as a function of the palette.
 *
 * Two sheets are built once at startup (see `ThemeProvider`) rather than being
 * rebuilt per render: `StyleSheet.create` is not free, and there are only ever
 * two possible answers. What is *not* baked in here is the accent — that is the
 * one colour that changes per tab, so it arrives at the call site from context.
 */
export function makeStyles(theme: Palette) {
    return StyleSheet.create({
        root: { flex: 1, backgroundColor: theme.bg },

        /* masthead — two rows, so the radio state gets room instead of truncating */
        header: {
            paddingHorizontal: space.lg,
            paddingTop: space.md,
            paddingBottom: space.md,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: theme.hairline,
            gap: space.xs,
        },
        headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
        nodeName: { ...typography.title, color: theme.text, flexShrink: 1 },
        nodeId: { ...typography.mono, color: theme.faint, flexShrink: 1 },
        /** Status as a bordered pill: a naked 8px dot is not a legible state. */
        statusPill: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            paddingHorizontal: space.md,
            paddingVertical: space.xs,
            borderRadius: radius.pill,
            borderWidth: 1,
        },
        statusText: { ...typography.label, letterSpacing: 0 },
        dot: { width: 7, height: 7, borderRadius: radius.pill },
        radioDetail: { ...typography.micro, color: theme.faint, flex: 1, textAlign: 'right' },

        /* tab strip — icon over label, and a short indicator that tracks the swipe.
           Anchored to the bottom, so the rule and the indicator both sit above
           the row: the indicator points back at the content it belongs to
           rather than at the gesture bar. */
        tabBar: {
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.hairline,
            backgroundColor: theme.bg,
        },
        tabs: { flexDirection: 'row' },
        tab: {
            flex: 1,
            paddingTop: space.md,
            paddingBottom: space.md,
            alignItems: 'center',
            gap: 3,
        },
        tabText: { ...typography.micro, color: theme.faint, letterSpacing: 0.6 },
        tabIndicatorTrack: { height: 2, backgroundColor: 'transparent' },
        tabIndicator: { height: 2, borderRadius: radius.pill },

        input: {
            flex: 1,
            backgroundColor: theme.panel,
            borderWidth: 1,
            borderColor: theme.hairline,
            borderRadius: radius.control,
            paddingHorizontal: space.lg,
            paddingVertical: space.md,
            color: theme.text,
            ...typography.body,
        },

        /* composer — a full-bleed sheet over the pager, not a page inside it.
           Rendered at the screen's root so `adjustResize` shrinks it with the
           keyboard the same way it shrinks everything else; a Modal is its own
           Android window and does not inherit that. */
        composer: { backgroundColor: theme.bg },
        composerBar: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: space.md,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: theme.hairline,
        },
        composerBarTitle: { ...typography.label, color: theme.faint, letterSpacing: 1.2 },
        /** The name, as a field: bordered, because it is a thing to fill in. */
        composerTitle: {
            backgroundColor: theme.panel,
            borderWidth: 1,
            borderColor: theme.hairline,
            borderRadius: radius.control,
            paddingHorizontal: space.md,
            paddingVertical: space.md,
            color: theme.text,
            ...typography.heading,
        },
        /** The body, as a page: no box. Text being written, not a form field. */
        composerBody: {
            flex: 1,
            marginTop: space.md,
            paddingBottom: space.md,
            color: theme.text,
            textAlignVertical: 'top',
            ...typography.body,
        },
        composerFoot: {
            paddingHorizontal: space.lg,
            paddingTop: space.md,
            paddingBottom: space.md,
            gap: space.sm,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.hairline,
        },
        composerCount: { ...typography.monoSm, color: theme.faint },

        summary: {
            ...typography.micro,
            color: theme.dim,
            paddingHorizontal: space.lg,
            paddingBottom: space.sm,
        },

        listPad: { padding: space.md, gap: space.md, paddingBottom: space.huge },
        empty: {
            ...typography.body,
            color: theme.faint,
            textAlign: 'center',
            paddingHorizontal: space.xl,
            paddingVertical: space.xxl,
        },
        emptyWrap: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl },
        lede: { ...typography.bodySm, color: theme.dim, marginBottom: space.sm },
        heroLede: { ...typography.body, color: theme.text, fontWeight: '600' },

        hit: {
            backgroundColor: theme.panel,
            borderWidth: 1,
            borderColor: theme.hairline,
            borderRadius: radius.card,
            padding: space.md,
        },
        hitTop: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: space.sm,
        },
        hitTitle: { ...typography.heading, color: theme.text, flex: 1 },
        hitScore: { ...typography.mono },
        hitBadge: {
            ...typography.micro,
            color: theme.faint,
            marginTop: space.xs,
            fontFamily: theme.mono,
        },
        hitText: { ...typography.bodySm, color: theme.dim, marginTop: space.sm },

        sectionTitle: {
            ...typography.micro,
            fontWeight: '600',
            color: theme.faint,
            letterSpacing: 1.2,
            marginTop: space.md,
            marginBottom: 2,
        },
        card: {
            backgroundColor: theme.panel,
            borderWidth: 1,
            borderColor: theme.hairline,
            borderRadius: radius.card,
            padding: space.lg,
        },
        /** A card that got a result worth trusting more, without a glow — a flat accent edge instead. */
        cardAccent: { borderLeftWidth: 3 },
        cardWarn: { borderColor: theme.warn },
        cardDanger: { borderColor: theme.danger },
        cardTitle: { ...typography.heading, color: theme.text, marginBottom: space.xs },
        cardBody: { ...typography.bodySm, color: theme.dim },

        statRow: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: space.md,
            paddingVertical: space.xs,
        },
        statLabel: { ...typography.bodySm, color: theme.dim, flexShrink: 1 },
        statValue: { ...typography.mono, color: theme.text },

        /* controls */
        chipRow: { flexDirection: 'row', gap: space.sm, marginTop: space.md, flexWrap: 'wrap' },
        chip: {
            borderWidth: 1,
            borderColor: theme.hairline,
            backgroundColor: theme.panelAlt,
            borderRadius: radius.pill,
            paddingHorizontal: space.md,
            paddingVertical: space.md,
            minHeight: 36,
            justifyContent: 'center',
        },
        chipCut: { borderColor: theme.danger },
        chipText: { ...typography.label, color: theme.dim },

        button: {
            flexDirection: 'row',
            gap: space.sm,
            borderRadius: radius.control,
            paddingHorizontal: space.xl,
            paddingVertical: space.md,
            minHeight: 44,
            justifyContent: 'center',
            alignItems: 'center',
        },
        buttonGhost: { backgroundColor: 'transparent', borderWidth: 1 },
        /**
         * A disabled control is dimmed, never recoloured. Swapping the fill for
         * a muted tint used to make "busy" and "nothing typed yet" look like two
         * different kinds of unavailable when they are the same one.
         */
        buttonDisabled: { opacity: 0.45 },
        buttonText: { ...typography.label, letterSpacing: 0.3 },
        /** Small inline action — sits inside a row, not under it. */
        buttonCompact: { paddingHorizontal: space.md, paddingVertical: space.sm, minHeight: 36 },

        /* two-tier storage meter */
        tierRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm },
        tierLabel: { ...typography.monoSm, color: theme.faint, width: 46 },
        tierBar: {
            flex: 1,
            height: 8,
            borderRadius: radius.pill,
            backgroundColor: theme.panelAlt,
            overflow: 'hidden',
        },
        tierFill: { height: 8, borderRadius: radius.pill },
        tierValue: { ...typography.monoSm, color: theme.dim, width: 108, textAlign: 'right' },

        progress: {
            height: 6,
            borderRadius: radius.pill,
            backgroundColor: theme.panelAlt,
            overflow: 'hidden',
            marginTop: space.sm,
        },
        progressFill: { height: 6, borderRadius: radius.pill },

        /** Explanatory prose. Sans, not the 11px monospace this used to be. */
        hint: { ...typography.micro, color: theme.faint, marginTop: space.sm },

        /* replica meter: one pip per possible copy */
        pips: { flexDirection: 'row', gap: 3, marginTop: space.sm },
        pip: { flex: 1, height: 5, borderRadius: radius.pill, backgroundColor: theme.panelAlt },

        /* wire log */
        logRow: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
        logKind: { ...typography.monoNano, width: 54, textTransform: 'uppercase' },
        logType: { ...typography.monoNano, width: 78 },
        logPeer: { ...typography.monoNano, color: theme.dim, width: 56 },
        logDetail: { ...typography.monoNano, color: theme.faint, flex: 1 },

        /* identity */
        fingerprint: {
            ...typography.readAloud,
            color: theme.text,
            letterSpacing: 1,
            marginTop: space.xs,
        },
        /** The same key, quoted inline beside an author's name rather than displayed. */
        authorLine: { ...typography.mono, color: theme.text },
        /** Layout only — the icons are sized at the call site, next to their type. */
        iconRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm },
        /** The header's copy, shrunk to sit on one line beside the node's counts. */
        iconRowTight: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
        headerIdent: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexShrink: 1 },
        safety: {
            ...typography.readAloudLg,
            color: theme.text,
            letterSpacing: 1.5,
            marginTop: space.sm,
        },
        /** Where a safety number is set for two people to compare, screen to screen. */
        safetyPanel: {
            marginTop: space.sm,
            padding: space.md,
            borderRadius: radius.control,
            backgroundColor: theme.bg,
            borderWidth: 1,
            borderColor: theme.hairline,
        },
        badge: {
            borderRadius: radius.pill,
            paddingHorizontal: space.sm,
            paddingVertical: 2,
            borderWidth: 1,
        },
        badgeText: { ...typography.micro, letterSpacing: 0.4, fontWeight: '600' },

        modeBadge: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            borderRadius: radius.pill,
        },
        modeBadgeText: { ...typography.micro, fontWeight: '700', letterSpacing: 0.3 },

        /* onboarding — flexGrow, not flex: a ScrollView content box that cannot
           grow past the viewport will not scroll when the keyboard is up */
        onboard: { flexGrow: 1, padding: space.xxl, justifyContent: 'center', gap: space.md },
        onboardTitle: { ...typography.display, color: theme.text },
        onboardBody: { ...typography.body, color: theme.dim },

        /* topology view */
        graph: {
            backgroundColor: theme.panel,
            borderRadius: radius.card,
            borderWidth: 1,
            borderColor: theme.hairline,
        },
        graphNode: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
        graphDisc: {
            borderWidth: 1.5,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.bg,
        },
        graphLabel: { ...typography.monoSm, color: theme.dim, marginTop: 3 },
        graphSub: { ...typography.monoNano, color: theme.faint },
        legend: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
        legendItem: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
        legendSwatch: { width: 8, height: 8, borderRadius: radius.pill },
        legendText: { ...typography.monoNano, color: theme.faint },
    });
}

export type Styles = ReturnType<typeof makeStyles>;
