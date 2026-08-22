import React, { useState } from 'react';
import { Pressable, View, Text } from 'react-native';
import type { MeshHit } from '../../mesh/MeshNode';
import { styles } from './styles';

export function HitRow({ hit, onOpen }: { hit: MeshHit; onOpen: () => void }) {
  const [open, setOpen] = useState(false);

  const origin = hit.local ? 'matched here' : `matched by ${hit.fromNodeName}`;
  const body = hit.text
    ? hit.local
      ? 'stored here'
      : `body from ${hit.holderName || 'mesh'}`
    : hit.holderName
      ? `snippet only · body on ${hit.holderName}`
      : 'snippet only';

  return (
    <Pressable
      style={styles.hit}
      onPress={() => {
        if (!open && !hit.text) void onOpen();
        setOpen((v) => !v);
      }}
    >
      <View style={styles.hitTop}>
        <Text style={styles.hitTitle} numberOfLines={1}>
          {hit.title || 'Untitled'}
        </Text>
        <Text style={styles.hitScore}>{hit.score.toFixed(2)}</Text>
      </View>
      <Text style={styles.hitBadge}>
        {origin} ▸ {body}
        {hit.hops > 0 ? ` · ${hit.hops}h` : ''}
      </Text>
      <Text style={styles.hitText}>{open && hit.text ? hit.text : hit.snippet}</Text>
    </Pressable>
  );
}
