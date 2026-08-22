import React from 'react';
import { Text, View } from 'react-native';

import { styles } from './styles';

export function Stat({
  label,
  value,
  render,
}: {
  label: string;
  value: number;
  /** Overrides the number, for rows whose value is not one. */
  render?: string;
}) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{render ?? value}</Text>
    </View>
  );
}
