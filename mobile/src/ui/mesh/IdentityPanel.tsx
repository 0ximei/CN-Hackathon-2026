import React, { useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import type { PeerIdentity } from '../../identity/trust';
import type { useMesh } from '../useMesh';
import { useTheme } from '../ThemeProvider';
import { space, trustLabel } from '../theme';
import { Button, Chip, Empty } from './Controls';

type Mesh = ReturnType<typeof useMesh>;

/**
 * This device's identity, and what it can say about everyone else's.
 *
 * Two different questions live here and are deliberately not merged:
 *
 *   "Is this node really the node id it claims?"  — the radio can answer this,
 *   by challenging it to sign a nonce with the key its id is a hash of.
 *
 *   "Is this node the person in front of me?"     — the radio *cannot* answer
 *   this, because an attacker in the room generates a perfectly valid key of
 *   their own. Only two people comparing a number on two screens can.
 *
 * So `key proven` and `verified in person` are separate states, and the second
 * is never awarded by software.
 */
export function IdentityPanel({ mesh }: { mesh: Mesh }) {
  const { styles, theme } = useTheme();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const identity = mesh.identity;
  if (!identity) return null;

  return (
    <>
      <Text style={styles.sectionTitle}>THIS NODE'S IDENTITY</Text>
      <View style={styles.card}>
        {editing ? (
          <View style={{ gap: space.sm }}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              autoFocus
              maxLength={24}
              placeholder={identity.name}
              placeholderTextColor={theme.faint}
              style={styles.input}
            />
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <Button
                label="Save"
                style={{ flex: 1 }}
                onPress={() => {
                  void mesh.rename(draft);
                  setEditing(false);
                }}
              />
              <Button
                label="Cancel"
                variant="ghost"
                style={{ flex: 1 }}
                onPress={() => setEditing(false)}
              />
            </View>
          </View>
        ) : (
          <View style={styles.hitTop}>
            <Text style={styles.hitTitle}>{identity.name}</Text>
            <Button
              label="Rename"
              variant="ghost"
              compact
              onPress={() => {
                setDraft(identity.name);
                setEditing(true);
              }}
            />
          </View>
        )}

        <Text style={styles.hitBadge}>
          node #{(identity.id >>> 0).toString(16).padStart(8, '0')} · Ed25519
        </Text>
        <Text style={styles.fingerprint}>{mesh.fingerprint?.hex}</Text>
        <Text style={styles.emojiRow}>{mesh.fingerprint?.emoji}</Text>
        <Text style={styles.hint}>
          The node id is a hash of the public key, so it is not a claim this device could make
          about someone else's key. Renaming keeps both.
        </Text>

        {identity.secureRandom === false && (
          <Text style={[styles.hint, { color: theme.warn }]}>
            This key was generated without the platform random number generator — the app was
            running a build made before expo-crypto was added. It works, and it is not a
            credential. Reinstall after a rebuild to regenerate it.
          </Text>
        )}
      </View>

      <Text style={styles.sectionTitle}>VERIFYING OTHER NODES</Text>
      {mesh.identities.length === 0 ? (
        <Empty icon="people-outline">
          Nobody met yet. Every node is challenged to prove its id the moment its first beacon
          arrives.
        </Empty>
      ) : (
        mesh.identities.map((peer) => <PeerIdentityRow key={peer.nodeId} peer={peer} mesh={mesh} />)
      )}
    </>
  );
}

function PeerIdentityRow({ peer, mesh }: { peer: PeerIdentity; mesh: Mesh }) {
  const { styles, theme } = useTheme();
  const [showSafety, setShowSafety] = useState(false);
  // Fixed trust colours, never the tab accent — see the note in `theme.ts`.
  const colour = theme.trust[peer.state] ?? theme.faint;
  const safety = showSafety ? mesh.safetyFor(peer.nodeId) : null;
  const online = mesh.peers.some((p) => p.nodeId === peer.nodeId);

  return (
    <View
      style={[
        styles.card,
        (peer.state === 'failed' || peer.state === 'mismatch') && styles.cardDanger,
      ]}
    >
      <View style={styles.hitTop}>
        <Text style={styles.hitTitle} numberOfLines={1}>
          {peer.name || `#${(peer.nodeId >>> 0).toString(16).padStart(8, '0')}`}
        </Text>
        <View style={[styles.badge, { borderColor: colour }]}>
          <Text style={[styles.badgeText, { color: colour }]}>
            {trustLabel[peer.state] ?? peer.state}
          </Text>
        </View>
      </View>

      <Text style={styles.hitBadge}>
        {peer.detail}
        {online ? '' : ' · offline'}
      </Text>

      {peer.state === 'mismatch' && (
        <Text style={[styles.hint, { color: theme.warn }]}>
          This id previously signed with a different key. That is a reinstall, or somebody else
          using the name. Compare the safety number in person before trusting it again.
        </Text>
      )}

      {safety && (
        // Set on its own panel: this is the one number in the app two people
        // read off two screens to each other, so it has to survive being held
        // at arm's length in bad light.
        <View style={styles.safetyPanel}>
          <Text style={[styles.hint, { marginTop: 0 }]}>
            Both phones should show exactly this. Read it aloud, or hold the screens together.
          </Text>
          <Text style={styles.safety}>{safety.digits}</Text>
          <Text style={styles.emojiRow}>{safety.emoji}</Text>
        </View>
      )}

      <View style={[styles.chipRow, { marginTop: space.md }]}>
        {online && (
          <Chip label="re-challenge" onPress={() => mesh.challengePeer(peer.nodeId)} />
        )}
        {peer.publicKeyHex ? (
          <Chip
            label={showSafety ? 'hide safety number' : 'safety number'}
            on={showSafety}
            onPress={() => setShowSafety((v) => !v)}
          />
        ) : null}
        {peer.state === 'verified' && (
          <Chip label="it matches" on onPress={() => void mesh.trustPeer(peer.nodeId)} />
        )}
        {peer.state === 'trusted' && (
          <Chip label="undo" onPress={() => void mesh.untrustPeer(peer.nodeId)} />
        )}
      </View>
    </View>
  );
}
