import React, { useMemo } from 'react';
import { FlatList, Text, View } from 'react-native';

import type { ActivityEvent } from '../../mesh/MeshNode';
import { useTheme } from '../ThemeProvider';
import { space } from '../theme';
import { Empty } from './Controls';

/**
 * The packet trace, so the routing is legible rather than magic.
 *
 * Four columns, because four different things are worth reading at a glance:
 * what happened to the packet, what kind of packet it was, which link it went
 * over, and why — a drop with no reason beside it is just a red line.
 *
 * The per-type colours are authored twice, once per paper: the bright greens
 * and blues that carry a dark log are washed out to nothing on cream, and a
 * legend nobody can read is worse than no legend.
 */
export function LogTab({ activity }: { activity: ActivityEvent[] }) {
  const { styles, theme } = useTheme();
  const newestFirst = useMemo(() => [...activity].reverse(), [activity]);

  return (
    <FlatList
      data={newestFirst}
      keyExtractor={(e) => String(e.seq)}
      contentContainerStyle={[styles.listPad, { gap: space.xs }]}
      renderItem={({ item }) => (
        <View style={styles.logRow}>
          <Text style={[styles.logKind, { color: theme.kind[item.kind] ?? theme.faint }]}>
            {item.kind}
          </Text>
          <Text style={[styles.logType, { color: theme.wire[item.type] ?? theme.dim }]}>
            {item.type}
          </Text>
          <Text style={styles.logPeer} numberOfLines={1}>
            {peerLabel(item.peer, item.peerNodeId)}
          </Text>
          <Text style={styles.logDetail} numberOfLines={2}>
            {[item.reason, item.detail].filter(Boolean).join(' · ')}
          </Text>
        </View>
      )}
      ListEmptyComponent={<Empty icon="pulse-outline">Nothing on the radio yet.</Empty>}
    />
  );
}

/** Node ids are 32-bit; the low half is enough to tell two phones apart. */
function peerLabel(peer: string, nodeId: number): string {
  if (peer === 'flood') return 'all';
  if (peer === 'local') return '—';
  if (nodeId) return `#${(nodeId & 0xffff).toString(16).padStart(4, '0')}`;
  return `#${peer.slice(0, 4)}`;
}
