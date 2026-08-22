import React from 'react';
import { Text, View } from 'react-native';

import type { useMesh } from '../useMesh';
import { styles } from './styles';
import { theme } from '../theme';

type Mesh = ReturnType<typeof useMesh>;

export function Header({ mesh }: { mesh: Mesh }) {
  const live = mesh.radio.state === 'running' || mesh.radio.state === 'advertising';
  const trouble = mesh.radio.state.includes('failed') || mesh.radio.state === 'error';
  const dot = trouble ? theme.danger : live ? theme.accent : theme.faint;

  return (
    <View style={styles.header}>
      <View style={{ flex: 1 }}>
        <Text style={styles.nodeName}>{mesh.identity?.name ?? '…'}</Text>
        {/* Knows versus stores, in the masthead, because it is the one number
            pair that says what kind of node this is right now. */}
        <Text style={styles.nodeId}>
          {mesh.fingerprint?.emoji.replace(/ /g, '') ?? ''}
          {'  '}
          knows {mesh.catalogStats.known} · stores {mesh.catalogStats.stored}
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
