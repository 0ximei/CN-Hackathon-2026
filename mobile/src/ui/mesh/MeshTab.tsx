import React, { useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View, Pressable } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import type { useMesh } from '../useMesh';
type Mesh = ReturnType<typeof useMesh>;

import { styles } from './styles';
import { theme } from '../theme';
import { PeerRow } from './PeerRow';
import { Stat } from './Stat';

async function readAssetText(uri: string): Promise<string> {
  const response = await fetch(uri);
  if (!response.ok) throw new Error(`could not read document: ${response.status}`);
  return response.text();
}

export function MeshTab({ mesh }: { mesh: Mesh }) {
  const caps = mesh.capabilities;
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
