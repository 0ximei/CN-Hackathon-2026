import React from 'react';
import { Text, View } from 'react-native';

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
 * The second row keeps the knows/stores pair the old header crammed against the
 * fingerprint emoji. It is still there because it is the one number pair that
 * says what kind of node this is right now — it just no longer competes with
 * the node's name for the same line.
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
        <Text style={styles.nodeId} numberOfLines={1}>
          {mesh.fingerprint?.emoji.replace(/ /g, '') ?? ''}
          {'  '}
          knows {mesh.catalogStats.known} · stores {mesh.catalogStats.stored}
        </Text>
        <Text style={[styles.radioDetail, trouble && { color: theme.danger }]} numberOfLines={1}>
          {mesh.radio.detail || mesh.radio.state}
        </Text>
      </View>
    </View>
  );
}
