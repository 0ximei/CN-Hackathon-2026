import React, { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';

import { MAX_BODY_REPLICAS } from '@core/replication/policy';

import type { useMesh } from '../useMesh';
import type { DocReplicaInfo } from '../../replication/Replicator';
import type { Provenance } from '../../storage/types';
import { styles } from './styles';
import { bytes, theme } from '../theme';

type Mesh = ReturnType<typeof useMesh>;

const PROVENANCE_LABEL: Record<Provenance, string> = {
  local: 'UPLOADED HERE',
  mesh: 'FROM THE MESH',
  seed: 'BUILT IN',
};

async function readAssetText(uri: string): Promise<string> {
  const response = await fetch(uri);
  if (!response.ok) throw new Error(`could not read document: ${response.status}`);
  return response.text();
}

export function FilesTab({ mesh }: { mesh: Mesh }) {
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const handleUpload = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
      type: ['text/plain', 'text/markdown', 'text/*'],
    });
    if (result.canceled || !result.assets?.length) return;

    setNote(null);
    try {
      const files = await Promise.all(
        result.assets.map(async (asset: { name?: string; uri: string }, i: number) => ({
          name: asset.name ?? `uploaded-${i}.txt`,
          text: await readAssetText(asset.uri),
        })),
      );
      await mesh.addFiles(files);
      setNote({
        ok: true,
        text: `Added ${files.length} file${files.length === 1 ? '' : 's'}. Metadata is on its way to the mesh; bodies follow where the policy places them.`,
      });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <FlatList
      data={mesh.documents}
      keyExtractor={(d) => String(d.docKey)}
      contentContainerStyle={styles.listPad}
      ListHeaderComponent={
        <View style={{ marginBottom: 4, gap: 8 }}>
          <Text style={styles.lede}>
            Upload a document and it enters the mesh here, then spreads by itself — metadata to
            everyone that ranks for it, full text to the nodes the policy picks.
          </Text>

          <Pressable
            onPress={() => void handleUpload()}
            disabled={mesh.upload.busy}
            style={[styles.button, mesh.upload.busy && styles.buttonBusy]}
          >
            {mesh.upload.busy ? (
              <ActivityIndicator color={theme.bg} size="small" />
            ) : (
              <Text style={styles.buttonText}>UPLOAD .TXT OR .MD</Text>
            )}
          </Pressable>

          {mesh.upload.busy && (
            <View>
              <View style={styles.progress}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      width: `${
                        mesh.upload.total ? (mesh.upload.done / mesh.upload.total) * 100 : 0
                      }%`,
                    },
                  ]}
                />
              </View>
              <Text style={styles.hint}>
                {mesh.upload.label}
                {mesh.upload.total
                  ? ` — ${mesh.upload.done}/${mesh.upload.total} passages embedded`
                  : ''}
              </Text>
            </View>
          )}

          {note && (
            <Text style={[styles.summary, !note.ok && { color: theme.warn }]}>{note.text}</Text>
          )}
        </View>
      }
      renderItem={({ item }) => (
        <DocRow doc={item} selfId={mesh.identity?.id ?? 0} onForget={() => mesh.forget(item.docKey)} />
      )}
      ListEmptyComponent={<Text style={styles.empty}>No documents yet. Upload one above.</Text>}
    />
  );
}

/**
 * One document, with the thing that actually matters about it: how many live
 * copies of its text exist across the mesh, versus how many the policy wants.
 *
 * "Live" is doing real work in that sentence — a holder that has walked out of
 * range is not availability, and counting it would show a document as safe at
 * the exact moment it stopped being so.
 */
function DocRow({
  doc,
  selfId,
  onForget,
}: {
  doc: DocReplicaInfo;
  selfId: number;
  onForget: () => void;
}) {
  const replicas = doc.meanReplicas;
  const short = replicas + 0.001 < doc.desired;
  const atRisk = replicas <= 1;
  const colour = atRisk ? theme.warn : short ? theme.link : theme.accent;

  return (
    <View style={styles.card}>
      <View style={styles.hitTop}>
        <Text style={styles.hitTitle} numberOfLines={1}>
          {doc.title}
        </Text>
        <Text style={[styles.hitScore, { color: colour }]}>
          {replicas.toFixed(1)}/{doc.desired} copies
        </Text>
      </View>

      <View style={styles.pips}>
        {Array.from({ length: MAX_BODY_REPLICAS }, (_, i) => (
          <View
            key={i}
            style={[
              styles.pip,
              i < Math.round(replicas)
                ? [styles.pipHeld, { backgroundColor: colour }]
                : i < doc.desired
                  ? styles.pipWanted
                  : null,
            ]}
          />
        ))}
      </View>

      <Text style={styles.hitBadge}>
        {doc.chunkCount} passage{doc.chunkCount === 1 ? '' : 's'} · {bytes(doc.bytes)} ·{' '}
        {doc.storedHere ? `${doc.storedHere} stored here` : 'metadata only'}
        {doc.hits > 0 ? ` · ${doc.hits} hits` : ''}
      </Text>

      <View style={[styles.hitTop, { marginTop: 8 }]}>
        <Text style={styles.hitBadge}>
          {PROVENANCE_LABEL[doc.provenance]}
          {doc.originId === selfId && doc.provenance !== 'seed' ? ' · uploaded here' : ''}
        </Text>
        <Pressable onPress={onForget} style={styles.buttonGhost}>
          <Text style={styles.buttonGhostText}>FORGET</Text>
        </Pressable>
      </View>
    </View>
  );
}
