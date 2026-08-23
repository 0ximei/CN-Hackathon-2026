import React, { useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { Authorship } from '../../identity/authorship';

import { MAX_BODY_REPLICAS } from '@core/replication/policy';
import { SUPPORTED_FORMATS } from '@core/lib/extract';

import type { useMesh } from '../useMesh';
import type { DocReplicaInfo } from '../../replication/Replicator';
import type { Provenance } from '../../storage/types';
import { useTheme } from '../ThemeProvider';
import { type Palette, bytes, space } from '../theme';
import { Button, Empty } from './Controls';
import { importDocument } from './importDocument';

type Mesh = ReturnType<typeof useMesh>;

const PROVENANCE_LABEL: Record<Provenance, string> = {
  local: 'UPLOADED HERE',
  mesh: 'FROM THE MESH',
};

/**
 * What this node knows, and how safely it knows it.
 *
 * Two ways in, because they are two different acts. Writing is authorship: the
 * text does not exist until someone types it, so it gets a screen, a draft and
 * a confirm on the way out (see `Composer.tsx`). Importing is not — the
 * document already exists, the author already stands behind it, and the only
 * question is whether it enters the mesh. So a picked file goes straight in.
 *
 * They were one path for a while, with an import landing its text in the
 * composer's body field as a first draft. It reads well and works badly: it
 * asks somebody to proof fifty pages of recovered PDF text before their file
 * will move, which made importing the slower of the two rather than the faster.
 *
 * A published document arrives at the top of this list a moment later with its
 * own replica meter, which is a truer account of what happened than a sentence
 * saying it went well — so success is shown rather than announced. What does get
 * said is what the list cannot show: which format a file was read as, since
 * extraction is a reading of a document rather than the document, and anything
 * that failed, because a file that did not import leaves no trace to notice.
 */
export function FilesTab({ mesh, onCompose }: { mesh: Mesh; onCompose: () => void }) {
  const { styles, theme, accent } = useTheme();
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  /** What the last import was read as. Cleared when the next one starts. */
  const [note, setNote] = useState('');

  /**
   * Pick a file and publish it. No screen in between, by design.
   *
   * `mesh.upload` drives the progress meter the composer also uses, so the
   * embedding pass is visible without this having to report on itself.
   */
  const onImport = async () => {
    setError('');
    setNote('');
    setImporting(true);
    try {
      const result = await importDocument();
      if (result.status === 'cancelled') return;
      if (result.status === 'error') {
        setError(result.message);
        return;
      }
      const { name, title, text, note: read } = result.document;
      await mesh.addFiles([{ name, text, title }]);
      // After the upload, not before: said about a document that is now on the
      // mesh, rather than about one that might still fail to get there.
      setNote(read);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const busy = importing || mesh.upload.busy;

  return (
    <FlatList
      data={mesh.documents}
      keyExtractor={(d) => String(d.docKey)}
      contentContainerStyle={styles.listPad}
      ListHeaderComponent={
        <View style={{ marginBottom: space.xs, gap: space.sm }}>
          <Text style={styles.lede}>
            Anything that enters the mesh here spreads by itself: metadata to everyone that ranks
            for it, full text to the nodes the policy picks.
          </Text>

          <Button
            label={importing ? 'Reading…' : 'Import a document'}
            icon="file-tray-outline"
            busy={importing}
            disabled={busy}
            onPress={() => void onImport()}
          />
          <Text style={[styles.hint, { marginTop: 0 }]}>
            {SUPPORTED_FORMATS} — read and published straight to the mesh.
          </Text>

          <Button
            label="Write a document"
            icon="create-outline"
            variant="ghost"
            disabled={busy}
            onPress={onCompose}
          />

          {mesh.upload.busy && (
            <View>
              <View style={[styles.progress, { marginTop: 0 }]}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      width: `${
                        mesh.upload.total ? (mesh.upload.done / mesh.upload.total) * 100 : 0
                      }%`,
                      backgroundColor: accent,
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

          {!!error && (
            <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' }}>
              <Ionicons name="alert-circle-outline" size={14} color={theme.warn} />
              <Text style={[styles.hint, { marginTop: 0, flex: 1, color: theme.warn }]}>
                {error}
              </Text>
            </View>
          )}

          {!!note && (
            <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' }}>
              <Ionicons name="document-attach-outline" size={14} color={theme.dim} />
              <Text style={[styles.hint, { marginTop: 0, flex: 1, color: theme.dim }]}>
                {note}
              </Text>
            </View>
          )}
        </View>
      }
      renderItem={({ item }) => (
        <DocRow
          doc={item}
          selfId={mesh.identity?.id ?? 0}
          author={authorName(mesh, item.originId)}
          onForget={() => mesh.forget(item.docKey)}
        />
      )}
      ListEmptyComponent={
        <Empty icon="document-outline">
          Nothing here yet. Everything this phone can answer offline starts as a document on this
          screen.
        </Empty>
      }
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
  author,
  onForget,
}: {
  doc: DocReplicaInfo;
  selfId: number;
  author: string;
  onForget: () => void;
}) {
  const { styles, theme } = useTheme();

  const replicas = doc.meanReplicas;
  const short = replicas + 0.001 < doc.desired;
  const atRisk = replicas <= 1;
  // Availability, not branding — so this reads off the fixed semantic colours
  // rather than the tab hue. "One live copy left" has to look like a warning on
  // every screen it can appear on.
  const colour = atRisk ? theme.warn : short ? theme.info : theme.positive;

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
                ? { backgroundColor: colour }
                : i < doc.desired
                  ? { backgroundColor: `${colour}44` }
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

      <Attestation doc={doc} author={author} selfId={selfId} />

      <View style={[styles.hitTop, { marginTop: space.sm }]}>
        <Text style={[styles.hitBadge, { marginTop: 0, flex: 1 }]}>
          {PROVENANCE_LABEL[doc.provenance]}
          {doc.originId === selfId ? ' · uploaded here' : ''}
        </Text>
        <Button label="Forget" variant="ghost" compact onPress={onForget} />
      </View>
    </View>
  );
}

/**
 * Authorship is a security claim, so its colours are fixed by the palette
 * rather than taken from the tab — a FORGED badge that shaded towards whichever
 * section you happened to be on would be reporting the navigation.
 */
const AUTHORSHIP: Record<
  Authorship,
  { label: string; colour: (t: Palette) => string; blurb: string }
> = {
  verified: {
    label: 'SIGNED',
    colour: (t) => t.positive,
    blurb: 'The signature checks out against a key that really does hash to this author id.',
  },
  unsigned: {
    label: 'UNSIGNED',
    colour: (t) => t.dim,
    blurb: 'Nothing was signed — it came from a node with no keys. Not an accusation.',
  },
  forged: {
    label: 'FORGED',
    colour: (t) => t.danger,
    blurb: 'A signature came with this and did not verify. The author shown cannot be trusted.',
  },
};

function authorName(mesh: Mesh, nodeId: number): string {
  if (nodeId === mesh.identity?.id) return mesh.identity.name;
  return mesh.peers.find((p) => p.nodeId === nodeId)?.name ?? hex8(nodeId);
}

function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}

/** First and last few bytes — enough to compare by eye, short enough to fit. */
function shortHex(b: Uint8Array | undefined): string {
  if (!b?.length) return '—';
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return hex.length <= 20 ? hex : `${hex.slice(0, 10)}…${hex.slice(-10)}`;
}

/**
 * Who wrote this, and whether that can be shown to be true.
 *
 * The author line is deliberately not rendered as plain fact. A node id in a
 * packet is a claim; it becomes attribution only once the signature and the
 * key-to-id binding have both checked out, and the badge is what separates
 * those two states on screen.
 */
function Attestation({
  doc,
  author,
  selfId,
}: {
  doc: DocReplicaInfo;
  author: string;
  selfId: number;
}) {
  const { styles, theme } = useTheme();
  const state = AUTHORSHIP[doc.authorship];
  const badge = state.colour(theme);

  return (
    <View style={{ marginTop: space.md }}>
      <View style={styles.hitTop}>
        <Text style={styles.statLabel}>AUTHOR</Text>
        <View style={[styles.badge, { borderColor: badge }]}>
          <Text style={[styles.badgeText, { color: badge }]}>{state.label}</Text>
        </View>
      </View>
      <Text style={styles.authorLine} numberOfLines={1}>
        {doc.authorship === 'forged' ? `claims ${author}` : author}
        <Text style={styles.hitBadge}>
          {'  '}
          {hex8(doc.originId)}
          {doc.originId === selfId ? ' · this node' : ''}
        </Text>
      </Text>

      <View style={[styles.statRow, { marginTop: space.sm }]}>
        <Text style={styles.statLabel}>SHA-256</Text>
        <Text style={styles.statValue}>{shortHex(doc.docHash)}</Text>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>SIGNATURE</Text>
        <Text style={styles.statValue}>{shortHex(doc.sig)}</Text>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>CONTENT</Text>
        <Text
          style={[
            styles.statValue,
            {
              color:
                doc.contentIntact === false
                  ? theme.danger
                  : doc.contentIntact
                    ? theme.positive
                    : theme.dim,
            },
          ]}
        >
          {doc.contentIntact === true
            ? 'matches the hash'
            : doc.contentIntact === false
              ? 'DOES NOT MATCH'
              : 'not held in full here'}
        </Text>
      </View>

      <Text style={styles.hint}>{state.blurb}</Text>
    </View>
  );
}
