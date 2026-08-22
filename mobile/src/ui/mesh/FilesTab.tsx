import React from 'react';
import { FlatList, Text, View } from 'react-native';
import type { useMesh } from '../useMesh';
import type { Provenance } from '../../storage/store';
type Mesh = ReturnType<typeof useMesh>;

import { styles } from './styles';

const PROVENANCE_LABEL: Record<Provenance, string> = {
  local: 'LOCAL',
  mesh: 'SHARED',
  seed: 'SEED',
};

export function FilesTab({ mesh }: { mesh: Mesh }) {
  return (
    <FlatList
      data={mesh.documents}
      keyExtractor={(d) => String(d.docKey)}
      contentContainerStyle={styles.listPad}
      renderItem={({ item }) => (
        <View style={styles.card}>
          <View style={styles.hitTop}>
            <Text style={styles.hitTitle}>{item.title}</Text>
            <Text style={styles.hitScore}>{PROVENANCE_LABEL[item.provenance]}</Text>
          </View>
          <Text style={styles.hitBadge}>
            {item.chunks} passage{item.chunks === 1 ? '' : 's'} · {item.bytes} bytes · {item.source}
          </Text>
        </View>
      )}
      ListEmptyComponent={
        <Text style={styles.empty}>No documents yet. Upload one from the MESH tab.</Text>
      }
    />
  );
}
