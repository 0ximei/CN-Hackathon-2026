import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { useMesh } from '../useMesh';
import { useTheme } from '../ThemeProvider';

type Mesh = ReturnType<typeof useMesh>;

/**
 * The masthead, in two rows rather than two columns.
 *
 * Whether the radio is actually up is the most consequential thing on screen —
 * every other number here is meaningless if it is down — and it used to be an
 * 8pt dot beside a line of 10px grey text that truncated. It now carries its own
 * bordered pill, and when the radio is in trouble the pill takes the danger
 * colour rather than leaving a red dot to do the work alone.
 *
 * The live state uses `positive`, not the tab accent: whether the radio is up
 * is a fact about the device, and it must not change colour because someone
 * swiped to a different tab.
 *
 * The second row pairs this node's fingerprint icons with its knows/stores
 * count. The icons are the same five the identity card shows, at the size the
 * surrounding text runs at — enough to recognise your own node at a glance,
 * never enough to verify anyone else's. That is the identity card's job, and
 * the icons here are a reminder that it exists.
 */
export function Header({ mesh }: { mesh: Mesh }) {
  const { styles, theme } = useTheme();

  const live = mesh.radio.state === 'running' || mesh.radio.state === 'advertising';
  const trouble = mesh.radio.state.includes('failed') || mesh.radio.state === 'error';
  const tint = trouble ? theme.danger : live ? theme.positive : theme.faint;
  const peers = mesh.peers.length;

  return (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        <Text style={styles.nodeName} numberOfLines={1}>
          {mesh.identity?.name ?? '…'}
        </Text>
        <View style={[styles.statusPill, { borderColor: tint }]}>
          <View style={[styles.dot, { backgroundColor: tint }]} />
          <Text style={[styles.statusText, { color: tint }]}>
            {peers} peer{peers === 1 ? '' : 's'}
          </Text>
        </View>
      </View>

      <View style={styles.headerRow}>
        <View style={styles.headerIdent}>
          <View style={styles.iconRowTight}>
            {mesh.fingerprint?.icons.map((name, i) => (
              <Ionicons key={i} name={name} size={12} color={theme.faint} />
            ))}
          </View>
          <Text style={styles.nodeId} numberOfLines={1}>
            knows {mesh.catalogStats.known} · stores {mesh.catalogStats.stored}
          </Text>
        </View>
        <Text style={[styles.radioDetail, trouble && { color: theme.danger }]} numberOfLines={1}>
          {mesh.radio.detail || mesh.radio.state}
        </Text>
      </View>
    </View>
  );
}
