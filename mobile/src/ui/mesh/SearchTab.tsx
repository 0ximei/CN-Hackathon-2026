import React, { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import type { useMesh } from '../useMesh';
type Mesh = ReturnType<typeof useMesh>;

import { styles } from './styles';
import { HitRow } from './HitRow';

export function SearchTab({ mesh }: { mesh: Mesh }) {
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
          placeholderTextColor={styles.summary.color}
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
            <ActivityIndicator color={styles.buttonText.color ?? undefined} size="small" />
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
