import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { MeshScreen } from './src/ui/MeshScreen';
import { theme } from './src/ui/theme';
import { useMesh } from './src/ui/useMesh';

export default function App() {
  const mesh = useMesh();

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        {mesh.phase === 'booting' && <Booting />}
        {mesh.phase === 'error' && <Failed reason={mesh.error} />}
        {mesh.phase === 'ready' && <MeshScreen mesh={mesh} />}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Booting() {
  return (
    <View style={styles.centre}>
      <ActivityIndicator color={theme.accent} />
      <Text style={styles.centreText}>Opening the radio…</Text>
    </View>
  );
}

/**
 * Every way this can fail is something the user can act on — Bluetooth off, a
 * permission denied, a chipset with no peripheral role — so the reason is shown
 * verbatim rather than collapsed into "something went wrong".
 */
function Failed({ reason }: { reason: string }) {
  return (
    <View style={styles.centre}>
      <Text style={styles.failTitle}>MeshNet could not start</Text>
      <Text style={styles.centreText}>{reason}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  centreText: { color: theme.dim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  failTitle: { color: theme.danger, fontSize: 17, fontWeight: '700' },
});
