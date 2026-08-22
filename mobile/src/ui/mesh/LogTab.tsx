import React, { useMemo } from 'react';
import { FlatList, Text, View } from 'react-native';

import type { ActivityEvent } from '../../mesh/MeshNode';
import { styles } from './styles';
import { kindColor, theme, wireColor } from '../theme';

/**
 * The packet trace, so the routing is legible rather than magic.
 *
 * Four columns, because four different things are worth reading at a glance:
 * what happened to the packet, what kind of packet it was, which link it went
 * over, and why — a drop with no reason beside it is just a red line.
 */
export function LogTab({ activity }: { activity: ActivityEvent[] }) {
  const newestFirst = useMemo(() => [...activity].reverse(), [activity]);

  return (
    <FlatList
      data={newestFirst}
      keyExtractor={(e) => String(e.seq)}
      contentContainerStyle={[styles.listPad, { gap: 4 }]}
      renderItem={({ item }) => (
        <View style={styles.logRow}>
          <Text style={[styles.logKind, { color: kindColor[item.kind] ?? theme.faint }]}>
            {item.kind}
          </Text>
          <Text style={[styles.logType, { color: wireColor[item.type] ?? theme.dim }]}>
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
      ListEmptyComponent={<Text style={styles.empty}>Nothing on the radio yet.</Text>}
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
