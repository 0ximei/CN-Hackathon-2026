import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { MeshHit } from '../../mesh/MeshNode';
import { styles } from './styles';
import { theme } from '../theme';

/**
 * One retrieved passage.
 *
 * "Found by", "stored on" and "retrieved from" are three different facts, and a
 * metadata-only node makes them come apart: it matched the passage from an
 * embedding it holds without holding the passage. Reporting only where the hit
 * came from would quietly let one node stand for all three, which is exactly
 * the thing the two-tier design exists to separate.
 */
export function HitRow({ hit, onOpen }: { hit: MeshHit; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const [fetching, setFetching] = useState(false);

  const origin = hit.local ? 'matched here' : `matched by ${hit.fromNodeName}`;
  const tier = hit.storedHere
    ? 'stored here'
    : hit.text
      ? `body from ${hit.holderName || 'mesh'}`
      : hit.holderName
        ? `snippet only · body on ${hit.holderName}`
        : 'snippet only · no holder known';

  return (
    <Pressable
      style={styles.hit}
      onPress={async () => {
        if (!open && !hit.text) {
          setFetching(true);
          try {
            await onOpen();
          } finally {
            setFetching(false);
          }
        }
        setOpen((v) => !v);
      }}
    >
      <View style={styles.hitTop}>
        <Text style={styles.hitTitle} numberOfLines={1}>
          {hit.section || hit.title || 'Untitled'}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
          <Ionicons name="stats-chart-outline" size={11} color={theme.accent} />
          <Text style={styles.hitScore}>{hit.score.toFixed(2)}</Text>
        </View>
      </View>
      <Text style={styles.hitBadge}>
        {origin} ▸ {tier}
        {hit.hops > 0 ? ` · ${hit.hops}h` : ''}
      </Text>
      <Text style={styles.hitText}>
        {fetching ? 'fetching the passage…' : open && hit.text ? hit.text : hit.snippet}
      </Text>
      {hit.section && hit.title !== hit.section ? (
        <Text style={styles.hitBadge}>{hit.title}</Text>
      ) : null}
    </Pressable>
  );
}
