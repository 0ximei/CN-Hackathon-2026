import React from 'react';
import { Text, View } from 'react-native';

import type { PeerState } from '../../mesh/MeshNode';
import { useTheme } from '../ThemeProvider';
import { bytes, space, trustLabel } from '../theme';
import { Button } from './Controls';

/**
 * One reachable node, with the inputs that decide where replicas go.
 *
 * Reliability is measured here and never reported by the peer — a node claiming
 * to be dependable is not evidence of anything. Free space is the opposite: it
 * is the one signal a node is the only authority on, so it is taken at its word.
 */
export function PeerRow({ peer, onVerify }: { peer: PeerState; onVerify?: () => void }) {
  const { styles, theme, accent } = useTheme();

  // Trust colours come from the palette, never from the tab accent: a peer that
  // is trusted has to look the same on every screen it appears on.
  const colour = theme.trust[peer.trust] ?? theme.faint;
  const suspicious = peer.trust === 'failed' || peer.trust === 'mismatch';

  return (
    <View style={[styles.card, suspicious && styles.cardDanger]}>
      <View style={styles.hitTop}>
        <Text style={styles.hitTitle} numberOfLines={1}>
          {peer.name}
        </Text>
        <Text style={[styles.hitScore, { color: accent }]}>
          {peer.hops <= 1 ? 'direct' : `${peer.hops} hops`}
        </Text>
      </View>

      <View style={[styles.hitTop, { marginTop: space.sm }]}>
        <View style={[styles.badge, { borderColor: colour }]}>
          <Text style={[styles.badgeText, { color: colour }]}>
            {trustLabel[peer.trust] ?? peer.trust}
          </Text>
        </View>
        {onVerify && (peer.trust === 'unknown' || suspicious) ? (
          <Button label="Challenge" variant="ghost" compact onPress={onVerify} />
        ) : null}
      </View>

      <Text style={styles.hitBadge}>
        #{peer.nodeId.toString(16).padStart(8, '0')} · knows {peer.known} · stores {peer.stored} ·{' '}
        {bytes(peer.freeBytes)} free
      </Text>

      {/* Reliability as a bar rather than a number: what matters on stage is
          that it moves when a phone is switched off, not its third decimal. */}
      <View style={styles.tierRow}>
        <Text style={styles.tierLabel}>trust</Text>
        <View style={styles.tierBar}>
          <View
            style={[
              styles.tierFill,
              { width: `${Math.round(peer.reliability * 100)}%`, backgroundColor: colour },
            ]}
          />
        </View>
        <Text style={styles.tierValue}>{Math.round(peer.reliability * 100)}% reliable</Text>
      </View>
    </View>
  );
}
