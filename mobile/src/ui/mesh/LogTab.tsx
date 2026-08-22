import React, { useMemo } from 'react';
import { FlatList, View, Text } from 'react-native';
import type { ActivityEvent } from '../../mesh/MeshNode';
import { styles } from './styles';
import { kindColor } from '../theme';

export function LogTab({ activity }: { activity: ActivityEvent[] }) {
  const reversed = useMemo(() => [...activity].reverse(), [activity]);
  return (
    <FlatList
      data={reversed}
      keyExtractor={(e, i) => `${e.at}-${i}`}
      contentContainerStyle={styles.listPad}
      renderItem={({ item }) => (
        <View style={styles.logRow}>
          <Text style={[styles.logKind, { color: kindColor[item.kind] ?? '#999' }]}>
            {item.kind}
          </Text>
          <Text style={styles.logLabel}>{item.label}</Text>
        </View>
      )}
      ListEmptyComponent={<Text style={styles.empty}>Nothing on the radio yet.</Text>}
    />
  );
}
