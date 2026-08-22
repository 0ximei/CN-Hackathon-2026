import React from 'react';
import { View, Text } from 'react-native';
import type { useMesh } from '../useMesh';
type Mesh = ReturnType<typeof useMesh>;

import { styles } from './styles';
import { theme } from '../theme';

export function Header({ mesh }: { mesh: Mesh }) {
  const live = mesh.radio.state === 'running' || mesh.radio.state === 'advertising';
  const trouble = mesh.radio.state.includes('failed') || mesh.radio.state === 'error';
  const dot = trouble ? theme.danger : live ? theme.accent : theme.faint;

  return (
    <View style={styles.header}>
      <View style={{ flex: 1 }}>
        <Text style={styles.nodeName}>{mesh.identity?.name ?? '…'}</Text>
        <Text style={styles.nodeId}>
          {mesh.identity ? `#${mesh.identity.id.toString(16).padStart(8, '0')}` : ''}
          {'  ·  '}
          {mesh.catalogStats.chunks} passages
        </Text>
      </View>
      <View style={styles.headerRight}>
        <View style={styles.radioRow}>
          <View style={[styles.dot, { backgroundColor: dot }]} />
          <Text style={styles.radioText}>
            {mesh.peers.length} peer{mesh.peers.length === 1 ? '' : 's'}
          </Text>
        </View>
        <Text style={styles.radioDetail} numberOfLines={1}>
          {mesh.radio.detail || mesh.radio.state}
        </Text>
      </View>
    </View>
  );
}
