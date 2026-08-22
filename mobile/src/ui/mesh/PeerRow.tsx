import React from 'react';
import { View, Text } from 'react-native';
import type { PeerState } from '../../mesh/MeshNode';
import { styles } from './styles';

export function PeerRow({ peer }: { peer: PeerState }) {
  return (
    <View style={styles.card}>
      <View style={styles.hitTop}>
        <Text style={styles.hitTitle}>{peer.name}</Text>
        <Text style={styles.hitScore}>{peer.hops <= 1 ? 'direct' : `${peer.hops} hops`}</Text>
      </View>
      <Text style={styles.hitBadge}>
        #{peer.nodeId.toString(16).padStart(8, '0')} · {peer.known} passages · {peer.documents}{' '}
        documents
      </Text>
    </View>
  );
}
