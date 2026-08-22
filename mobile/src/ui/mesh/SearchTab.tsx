import React, { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import type { useMesh } from '../useMesh';
type Mesh = ReturnType<typeof useMesh>;

import { styles } from './styles';
import { HitRow } from './HitRow';

async function readAssetText(uri: string): Promise<string> {
  const response = await fetch(uri);
  if (!response.ok) throw new Error(`could not read document: ${response.status}`);
  return response.text();
}

export function SearchTab({ mesh }: { mesh: Mesh }) {
  const [text, setText] = useState('');
  const hits = mesh.query?.hits ?? [];

  const handleUpload = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
      type: ['public.plain-text', 'public.text', 'net.daringfireball.markdown'],
    });

    if (result.canceled || !result.assets?.length) return;
    const files = await Promise.all(
      result.assets.map(async (asset: { name?: string; uri: string }) => ({
        name: asset.name ?? 'uploaded.txt',
        text: await readAssetText(asset.uri),
      })),
    );
    await mesh.addFiles(files);
  };

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

      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 8 }}>
        <Pressable onPress={() => void handleUpload()} style={[styles.button, { flex: 1 }]}>
          <Text style={styles.buttonText}>UPLOAD</Text>
        </Pressable>
        <Pressable onPress={() => void mesh.loadLlm()} style={[styles.button, { flex: 1, backgroundColor: '#1d4ed8' }]}>
          <Text style={styles.buttonText}>{mesh.llmStatus.phase === 'loading' ? 'LOADING…' : 'LLM'}</Text>
        </Pressable>
      </View>

      {!!summary && <Text style={styles.summary}>{summary}</Text>}

      {mesh.answerText ? (
        <View style={[styles.card, { marginHorizontal: 12, marginBottom: 12 }]}> 
          <Text style={styles.cardTitle}>Answer</Text>
          <Text style={styles.cardBody}>{mesh.answerText}</Text>
        </View>
      ) : null}

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
