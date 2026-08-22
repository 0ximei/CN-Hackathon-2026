import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { ActivityEvent, MeshHit, PeerState } from '../mesh/MeshNode';
import { kindColor, theme } from './theme';
import type { useMesh } from './useMesh';

type Mesh = ReturnType<typeof useMesh>;
type Tab = 'search' | 'mesh' | 'log';

export function MeshScreen({ mesh }: { mesh: Mesh }) {
  const [tab, setTab] = useState<Tab>('search');

  return (
    <View style={styles.root}>
      <Header mesh={mesh} />
      <View style={styles.tabs}>
        {(['search', 'mesh', 'log'] as Tab[]).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, tab === t && styles.tabOn]}>
            <Text style={[styles.tabText, tab === t && styles.tabTextOn]}>{t.toUpperCase()}</Text>
          </Pressable>
        ))}
      </View>
      {tab === 'search' && <SearchTab mesh={mesh} />}
      {tab === 'mesh' && <MeshTab mesh={mesh} />}
      {tab === 'log' && <LogTab activity={mesh.activity} />}
    </View>
  );
}

/* ----------------------------- header ----------------------------- */

function Header({ mesh }: { mesh: Mesh }) {
  const live = mesh.radio.state === 'running' || mesh.radio.state === 'advertising';
  const trouble = mesh.radio.state.includes('failed') || mesh.radio.state === 'error';
  const dot = trouble ? theme.danger : live ? theme.accent : theme.faint;

  return (
    <View style={styles.header}>
      <View style={{ flex: 1 }}>
        <Text style={styles.nodeName}>{mesh.identity?.name ?? '…'}</Text>
        <Text style={styles.nodeId}>
          {mesh.identity ? `#${mesh.identity.id.toString(16).padStart(8, '0')}` : ''}
          {'  ·  '}
          {mesh.catalogStats.chunks} passages
        </Text>
      </View>
      <View style={styles.headerRight}>
        <View style={styles.radioRow}>
          <View style={[styles.dot, { backgroundColor: dot }]} />
          <Text style={styles.radioText}>
            {mesh.peers.length} peer{mesh.peers.length === 1 ? '' : 's'}
          </Text>
        </View>
        <Text style={styles.radioDetail} numberOfLines={1}>
          {mesh.radio.detail || mesh.radio.state}
        </Text>
      </View>
    </View>
  );
}

/* ----------------------------- search ----------------------------- */

function SearchTab({ mesh }: { mesh: Mesh }) {
  const [text, setText] = useState('');
  const hits = mesh.query?.hits ?? [];

  const summary = useMemo(() => {
    if (!mesh.query) return '';
    const local = hits.filter((h) => h.local).length;
    const remote = hits.length - local;
    const parts = [`${local} local`];
    if (remote) parts.push(`${remote} from mesh`);
    if (mesh.query.finishedAt) {
      parts.push(`${((mesh.query.finishedAt - mesh.query.startedAt) / 1000).toFixed(1)}s`);
    }
    return parts.join(' · ');
  }, [hits, mesh.query]);

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.searchBar}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="how do I treat a burn"
          placeholderTextColor={theme.faint}
          style={styles.input}
          returnKeyType="search"
          onSubmitEditing={() => mesh.search(text)}
        />
        <Pressable
          onPress={() => mesh.search(text)}
          disabled={mesh.searching}
          style={[styles.button, mesh.searching && styles.buttonBusy]}
        >
          {mesh.searching ? (
            <ActivityIndicator color={theme.bg} size="small" />
          ) : (
            <Text style={styles.buttonText}>ASK</Text>
          )}
        </Pressable>
      </View>

      {!!summary && <Text style={styles.summary}>{summary}</Text>}

      <FlatList
        data={hits}
        keyExtractor={(h) => String(h.docId)}
        contentContainerStyle={styles.listPad}
        renderItem={({ item }) => <HitRow hit={item} onOpen={() => mesh.openHit(item.docId)} />}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {mesh.searching
              ? 'Waiting for the mesh…'
              : mesh.query
                ? 'Nothing in the mesh covers that.'
                : 'Ask something. Local passages answer instantly; the rest arrive over Bluetooth.'}
          </Text>
        }
      />
    </View>
  );
}

function HitRow({ hit, onOpen }: { hit: MeshHit; onOpen: () => void }) {
  const [open, setOpen] = useState(false);

  /**
   * Where a passage was matched, where it is stored, and whether its body has
   * actually arrived are three different facts. A node can match a passage it
   * does not hold, so collapsing them into one badge would let "this node"
   * stand for all three.
   */
  const origin = hit.local ? 'matched here' : `matched by ${hit.fromNodeName}`;
  const body = hit.text
    ? hit.local
      ? 'stored here'
      : `body from ${hit.holderName || 'mesh'}`
    : hit.holderName
      ? `snippet only · body on ${hit.holderName}`
      : 'snippet only';

  return (
    <Pressable
      style={styles.hit}
      onPress={() => {
        if (!open && !hit.text) void onOpen();
        setOpen((v) => !v);
      }}
    >
      <View style={styles.hitTop}>
        <Text style={styles.hitTitle} numberOfLines={1}>
          {hit.title || 'Untitled'}
        </Text>
        <Text style={styles.hitScore}>{hit.score.toFixed(2)}</Text>
      </View>
      <Text style={styles.hitBadge}>
        {origin} ▸ {body}
        {hit.hops > 0 ? ` · ${hit.hops}h` : ''}
      </Text>
      <Text style={styles.hitText}>{open && hit.text ? hit.text : hit.snippet}</Text>
    </Pressable>
  );
}

/* ------------------------------ mesh ------------------------------ */

function MeshTab({ mesh }: { mesh: Mesh }) {
  const caps = mesh.capabilities;

  return (
    <ScrollView contentContainerStyle={styles.listPad}>
      {caps && !caps.canAdvertise && (
        <View style={[styles.card, styles.cardWarn]}>
          <Text style={styles.cardTitle}>This phone cannot advertise</Text>
          <Text style={styles.cardBody}>
            Its Bluetooth chipset has no peripheral role, so scanners will never see it. It can
            still dial out and take part as a leaf node, but it cannot relay for anyone.
          </Text>
        </View>
      )}
      {caps && !caps.enabled && (
        <View style={[styles.card, styles.cardWarn]}>
          <Text style={styles.cardTitle}>Bluetooth is off</Text>
          <Text style={styles.cardBody}>Turn it on, then restart the app.</Text>
        </View>
      )}

      <Text style={styles.sectionTitle}>REACHABLE NODES</Text>
      {mesh.peers.length === 0 ? (
        <Text style={styles.empty}>
          No peers yet. Open MeshNet on a second Android phone within a few metres — discovery
          usually takes five to fifteen seconds.
        </Text>
      ) : (
        mesh.peers.map((peer) => <PeerRow key={peer.nodeId} peer={peer} />)
      )}

      <Text style={styles.sectionTitle}>TRAFFIC</Text>
      <View style={styles.card}>
        <Stat label="sent" value={mesh.stats.sent} />
        <Stat label="received" value={mesh.stats.received} />
        <Stat label="forwarded" value={mesh.stats.forwarded} />
        <Stat label="duplicates dropped" value={mesh.stats.duplicates} />
        <Stat label="dropped" value={mesh.stats.dropped} />
        <Stat label="parked for offline peers" value={mesh.stats.queued} />
      </View>

      <Text style={styles.sectionTitle}>THIS NODE'S SHARE</Text>
      <View style={styles.card}>
        <Text style={styles.cardBody}>
          Holding {mesh.catalogStats.chunks} passages from {mesh.catalogStats.documents} documents
          ({Math.round(mesh.coverage * 100)}% of the corpus). A node deliberately holds only part
          of it, so a search has something to go looking for.
        </Text>
        <View style={styles.coverageRow}>
          {[0.35, 0.6, 1].map((value) => (
            <Pressable
              key={value}
              onPress={() => mesh.changeCoverage(value)}
              style={[styles.chip, Math.abs(mesh.coverage - value) < 0.01 && styles.chipOn]}
            >
              <Text
                style={[
                  styles.chipText,
                  Math.abs(mesh.coverage - value) < 0.01 && styles.chipTextOn,
                ]}
              >
                {value === 1 ? 'everything' : `${Math.round(value * 100)}%`}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

function PeerRow({ peer }: { peer: PeerState }) {
  return (
    <View style={styles.card}>
      <View style={styles.hitTop}>
        <Text style={styles.hitTitle}>{peer.name}</Text>
        <Text style={styles.hitScore}>
          {peer.hops <= 1 ? 'direct' : `${peer.hops} hops`}
        </Text>
      </View>
      <Text style={styles.hitBadge}>
        #{peer.nodeId.toString(16).padStart(8, '0')} · {peer.known} passages · {peer.documents}{' '}
        documents
      </Text>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

/* ------------------------------- log ------------------------------ */

function LogTab({ activity }: { activity: ActivityEvent[] }) {
  const reversed = useMemo(() => [...activity].reverse(), [activity]);
  return (
    <FlatList
      data={reversed}
      keyExtractor={(e, i) => `${e.at}-${i}`}
      contentContainerStyle={styles.listPad}
      renderItem={({ item }) => (
        <View style={styles.logRow}>
          <Text style={[styles.logKind, { color: kindColor[item.kind] ?? theme.dim }]}>
            {item.kind}
          </Text>
          <Text style={styles.logLabel}>{item.label}</Text>
        </View>
      )}
      ListEmptyComponent={<Text style={styles.empty}>Nothing on the radio yet.</Text>}
    />
  );
}

/* ------------------------------ styles ---------------------------- */

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  headerRight: { alignItems: 'flex-end', maxWidth: '45%' },
  nodeName: { color: theme.text, fontSize: 20, fontWeight: '700' },
  nodeId: { color: theme.faint, fontSize: 12, fontFamily: theme.mono, marginTop: 2 },
  radioRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  radioText: { color: theme.dim, fontSize: 13 },
  radioDetail: { color: theme.faint, fontSize: 11, marginTop: 2 },

  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: theme.border },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  tabOn: { borderBottomWidth: 2, borderBottomColor: theme.accent },
  tabText: { color: theme.faint, fontSize: 12, letterSpacing: 1 },
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
    justifyContent: 'center',
    minWidth: 64,
    alignItems: 'center',
  },
  buttonBusy: { backgroundColor: theme.accentDim },
  buttonText: { color: theme.bg, fontWeight: '700', letterSpacing: 1 },
  summary: { color: theme.dim, fontSize: 12, paddingHorizontal: 16, paddingBottom: 6 },

  listPad: { padding: 12, gap: 10, paddingBottom: 40 },
  empty: { color: theme.faint, fontSize: 14, textAlign: 'center', padding: 24, lineHeight: 20 },

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
    marginTop: 12,
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
  cardTitle: { color: theme.text, fontWeight: '600', fontSize: 14, marginBottom: 4 },
  cardBody: { color: theme.dim, fontSize: 13, lineHeight: 19 },

  statRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  statLabel: { color: theme.dim, fontSize: 13 },
  statValue: { color: theme.text, fontSize: 13, fontFamily: theme.mono },

  coverageRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  chip: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipOn: { borderColor: theme.accent, backgroundColor: theme.accentDim },
  chipText: { color: theme.dim, fontSize: 12 },
  chipTextOn: { color: theme.text },

  logRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  logKind: { fontSize: 10, fontFamily: theme.mono, width: 58, textTransform: 'uppercase' },
  logLabel: { color: theme.dim, fontSize: 12, fontFamily: theme.mono, flex: 1 },
});
