import React, { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import type { useMesh } from '../useMesh';
import type { Provenance } from '../../storage/store';
type Mesh = ReturnType<typeof useMesh>;

import { styles } from './styles';
import { theme } from '../theme';

const PROVENANCE_LABEL: Record<Provenance, string> = {
  local: 'LOCAL',
  mesh: 'SHARED',
  seed: 'SEED',
};

async function readAssetText(uri: string): Promise<string> {
  const response = await fetch(uri);
  if (!response.ok) throw new Error(`could not read document: ${response.status}`);
  return response.text();
}

export function FilesTab({ mesh }: { mesh: Mesh }) {
  const [uploading, setUploading] = useState(false);
  const [uploadNote, setUploadNote] = useState<{ ok: boolean; text: string } | null>(null);

  const handleUpload = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
      type: ['text/plain', 'text/markdown', 'text/*'],
    });

    if (result.canceled || !result.assets?.length) return;
    setUploading(true);
    setUploadNote(null);
    try {
      const files = await Promise.all(
        result.assets.map(async (asset: { name?: string; uri: string }, i: number) => ({
          name: asset.name ?? `uploaded-${i}.txt`,
          text: await readAssetText(asset.uri),
        })),
      );
      await mesh.addFiles(files);
      setUploadNote({
        ok: true,
        text: `Added ${files.length} file${files.length === 1 ? '' : 's'} to this node's share.`,
      });
    } catch (e) {
      setUploadNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setUploading(false);
    }
  };

  return (
    <FlatList
      data={mesh.documents}
      keyExtractor={(d) => String(d.docKey)}
      contentContainerStyle={styles.listPad}
      ListHeaderComponent={
        <View style={{ marginBottom: 12 }}>
          <Pressable
            onPress={() => void handleUpload()}
            disabled={uploading}
            style={[styles.button, uploading && styles.buttonBusy]}
          >
            {uploading ? (
              <ActivityIndicator color={styles.buttonText.color ?? undefined} size="small" />
            ) : (
              <Text style={styles.buttonText}>UPLOAD FILES</Text>
            )}
          </Pressable>
          {uploadNote && (
            <Text style={[styles.summary, !uploadNote.ok && { color: theme.warn }]}>
              {uploadNote.text}
            </Text>
          )}
        </View>
      }
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
      ListEmptyComponent={<Text style={styles.empty}>No documents yet. Upload one above.</Text>}
    />
  );
}
