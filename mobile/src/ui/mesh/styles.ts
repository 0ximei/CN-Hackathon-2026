import { StyleSheet } from 'react-native';
import { theme } from '../theme';

export const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.bg },

    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: theme.border,
    },
    headerRight: { alignItems: 'flex-end', maxWidth: '46%' },
    nodeName: { color: theme.text, fontSize: 19, fontWeight: '700' },
    nodeId: { color: theme.faint, fontSize: 11, fontFamily: theme.mono, marginTop: 2 },
    radioRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    radioText: { color: theme.dim, fontSize: 13 },
    radioDetail: { color: theme.faint, fontSize: 10, marginTop: 2 },

    tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: theme.border },
    tab: { flex: 1, paddingVertical: 10, alignItems: 'center' },
    tabOn: { borderBottomWidth: 2, borderBottomColor: theme.accent },
    tabText: { color: theme.faint, fontSize: 11, letterSpacing: 1 },
    tabTextOn: { color: theme.text },

    searchBar: { flexDirection: 'row', padding: 12, gap: 8 },
    input: {
        flex: 1,
        backgroundColor: theme.panel,
        borderWidth: 1,
        borderColor: theme.border,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        color: theme.text,
        fontSize: 15,
    },
    button: {
        backgroundColor: theme.accent,
        borderRadius: 8,
        paddingHorizontal: 18,
        paddingVertical: 12,
        justifyContent: 'center',
        minWidth: 64,
        alignItems: 'center',
    },
    buttonBusy: { backgroundColor: theme.accentDim },
    buttonText: { color: theme.bg, fontWeight: '700', letterSpacing: 1 },
    buttonGhost: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: theme.border,
        borderRadius: 8,
        paddingHorizontal: 14,
        paddingVertical: 9,
        alignItems: 'center',
    },
    buttonGhostText: { color: theme.dim, fontSize: 12, letterSpacing: 0.6 },
    summary: { color: theme.dim, fontSize: 12, paddingHorizontal: 16, paddingBottom: 6 },

    listPad: { padding: 12, gap: 10, paddingBottom: 48 },
    empty: { color: theme.faint, fontSize: 14, textAlign: 'center', padding: 24, lineHeight: 20 },
    lede: { color: theme.dim, fontSize: 12, lineHeight: 18, marginBottom: 8 },

    hit: {
        backgroundColor: theme.panel,
        borderWidth: 1,
        borderColor: theme.border,
        borderRadius: 10,
        padding: 12,
    },
    hitTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    hitTitle: { color: theme.text, fontSize: 15, fontWeight: '600', flex: 1 },
    hitScore: { color: theme.accent, fontSize: 12, fontFamily: theme.mono },
    hitBadge: { color: theme.faint, fontSize: 11, marginTop: 4, fontFamily: theme.mono },
    hitText: { color: theme.dim, fontSize: 13, marginTop: 8, lineHeight: 19 },

    sectionTitle: {
        color: theme.faint,
        fontSize: 11,
        letterSpacing: 1.5,
        marginTop: 14,
        marginBottom: 2,
    },
    card: {
        backgroundColor: theme.panel,
        borderWidth: 1,
        borderColor: theme.border,
        borderRadius: 10,
        padding: 12,
    },
    cardWarn: { borderColor: theme.warn },
    cardDanger: { borderColor: theme.danger },
    cardTitle: { color: theme.text, fontWeight: '600', fontSize: 14, marginBottom: 4 },
    cardBody: { color: theme.dim, fontSize: 13, lineHeight: 19 },

    statRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
    statLabel: { color: theme.dim, fontSize: 13 },
    statValue: { color: theme.text, fontSize: 13, fontFamily: theme.mono },

    chipRow: { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' },
    chip: {
        borderWidth: 1,
        borderColor: theme.border,
        borderRadius: 999,
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    chipOn: { borderColor: theme.accent, backgroundColor: theme.accentDim },
    chipCut: { borderColor: theme.danger },
    chipText: { color: theme.dim, fontSize: 12 },
    chipTextOn: { color: theme.text },

    /* two-tier storage meter */
    tierRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
    tierLabel: { color: theme.faint, fontSize: 11, fontFamily: theme.mono, width: 46 },
    tierBar: {
        flex: 1,
        height: 8,
        borderRadius: 4,
        backgroundColor: theme.panelAlt,
        overflow: 'hidden',
    },
    tierFillMeta: { height: 8, backgroundColor: theme.link },
    tierFillBody: { height: 8, backgroundColor: theme.accent },
    tierValue: { color: theme.dim, fontSize: 11, fontFamily: theme.mono, width: 108, textAlign: 'right' },

    progress: {
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.panelAlt,
        overflow: 'hidden',
        marginTop: 8,
    },
    progressFill: { height: 6, backgroundColor: theme.accent },
    hint: { color: theme.faint, fontSize: 11, fontFamily: theme.mono, marginTop: 6 },

    /* replica meter: one pip per possible copy */
    pips: { flexDirection: 'row', gap: 3, marginTop: 8 },
    pip: { flex: 1, height: 5, borderRadius: 3, backgroundColor: theme.panelAlt },
    pipHeld: { backgroundColor: theme.accent },
    pipWanted: { backgroundColor: theme.accentDim },

    /* wire log */
    logRow: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
    logKind: { fontSize: 9, fontFamily: theme.mono, width: 54, textTransform: 'uppercase' },
    logType: { fontSize: 10, fontFamily: theme.mono, width: 78 },
    logPeer: { color: theme.dim, fontSize: 10, fontFamily: theme.mono, width: 56 },
    logDetail: { color: theme.faint, fontSize: 10, fontFamily: theme.mono, flex: 1 },

    /* identity */
    fingerprint: {
        color: theme.text,
        fontSize: 15,
        fontFamily: theme.mono,
        letterSpacing: 1,
        marginTop: 4,
    },
    emojiRow: { fontSize: 22, letterSpacing: 4, marginTop: 6 },
    safety: {
        color: theme.text,
        fontSize: 17,
        fontFamily: theme.mono,
        letterSpacing: 1.5,
        lineHeight: 26,
        marginTop: 6,
    },
    badge: {
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderWidth: 1,
    },
    badgeText: { fontSize: 10, letterSpacing: 0.5 },

    /* onboarding */
    onboard: { flex: 1, padding: 24, justifyContent: 'center', gap: 14 },
    onboardTitle: { color: theme.text, fontSize: 26, fontWeight: '700' },
    onboardBody: { color: theme.dim, fontSize: 14, lineHeight: 21 },

    /* topology view */
    graph: { backgroundColor: theme.panel, borderRadius: 12, borderWidth: 1, borderColor: theme.border },
    graphNode: {
        position: 'absolute',
        alignItems: 'center',
        justifyContent: 'center',
    },
    graphDisc: {
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.bg,
    },
    graphLabel: { color: theme.dim, fontSize: 10, marginTop: 3, fontFamily: theme.mono },
    graphSub: { color: theme.faint, fontSize: 9, fontFamily: theme.mono },
    legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    legendSwatch: { width: 8, height: 8, borderRadius: 4 },
    legendText: { color: theme.faint, fontSize: 10, fontFamily: theme.mono },
});
