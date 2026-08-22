import React, { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import type { PeerIdentity } from '../../identity/trust';
import type { useMesh } from '../useMesh';
import { styles } from './styles';
import { theme, trustColor, trustLabel } from '../theme';

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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const identity = mesh.identity;
  if (!identity) return null;

  return (
    <>
      <Text style={styles.sectionTitle}>THIS NODE'S IDENTITY</Text>
      <View style={styles.card}>
        {editing ? (
          <View style={{ gap: 8 }}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              autoFocus
              maxLength={24}
              placeholder={identity.name}
              placeholderTextColor={theme.faint}
              style={styles.input}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable
                style={[styles.button, { flex: 1 }]}
                onPress={() => {
                  void mesh.rename(draft);
                  setEditing(false);
                }}
              >
                <Text style={styles.buttonText}>SAVE</Text>
              </Pressable>
              <Pressable
                style={[styles.buttonGhost, { flex: 1 }]}
                onPress={() => setEditing(false)}
              >
                <Text style={styles.buttonGhostText}>CANCEL</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.hitTop}>
            <Text style={styles.hitTitle}>{identity.name}</Text>
            <Pressable
              onPress={() => {
                setDraft(identity.name);
                setEditing(true);
              }}
              style={styles.buttonGhost}
            >
              <Text style={styles.buttonGhostText}>RENAME</Text>
            </Pressable>
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
        <Text style={styles.empty}>
          Nobody met yet. Every node is challenged to prove its id the moment its first beacon
          arrives.
        </Text>
      ) : (
        mesh.identities.map((peer) => <PeerIdentityRow key={peer.nodeId} peer={peer} mesh={mesh} />)
      )}
    </>
  );
}

function PeerIdentityRow({ peer, mesh }: { peer: PeerIdentity; mesh: Mesh }) {
  const [showSafety, setShowSafety] = useState(false);
  const colour = trustColor[peer.state] ?? theme.faint;
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
        <View style={{ marginTop: 8 }}>
          <Text style={styles.hint}>
            Both phones should show exactly this. Read it aloud, or hold the screens together.
          </Text>
          <Text style={styles.safety}>{safety.digits}</Text>
          <Text style={styles.emojiRow}>{safety.emoji}</Text>
        </View>
      )}

      <View style={[styles.chipRow, { marginTop: 10 }]}>
        {online && (
          <Pressable onPress={() => mesh.challengePeer(peer.nodeId)} style={styles.chip}>
            <Text style={styles.chipText}>re-challenge</Text>
          </Pressable>
        )}
        {peer.publicKeyHex ? (
          <Pressable onPress={() => setShowSafety((v) => !v)} style={styles.chip}>
            <Text style={styles.chipText}>
              {showSafety ? 'hide safety number' : 'safety number'}
            </Text>
          </Pressable>
        ) : null}
        {peer.state === 'verified' && (
          <Pressable
            onPress={() => void mesh.trustPeer(peer.nodeId)}
            style={[styles.chip, styles.chipOn]}
          >
            <Text style={[styles.chipText, styles.chipTextOn]}>it matches</Text>
          </Pressable>
        )}
        {peer.state === 'trusted' && (
          <Pressable onPress={() => void mesh.untrustPeer(peer.nodeId)} style={styles.chip}>
            <Text style={styles.chipText}>undo</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
