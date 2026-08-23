import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { MeshScreen } from './src/ui/MeshScreen';
import { OnboardingScreen } from './src/ui/OnboardingScreen';
import { ThemeProvider, useTheme } from './src/ui/ThemeProvider';
import { space, typography } from './src/ui/theme';
import { useMesh } from './src/ui/useMesh';

export default function App() {
  const mesh = useMesh();

  return (
    <ThemeProvider preference={mesh.scheme} onPreferenceChange={mesh.chooseScheme}>
      <SafeAreaProvider>
        <Shell mesh={mesh} />
      </SafeAreaProvider>
    </ThemeProvider>
  );
}

/**
 * Split from `App` only so it sits *inside* the provider — the status bar and
 * the safe area both need to know which paper is in force, and a component
 * cannot read a context it is itself rendering.
 */
function Shell({ mesh }: { mesh: ReturnType<typeof useMesh> }) {
  const { theme } = useTheme();

  return (
    <>
      {/* Inverted against the paper, not pinned: light text on a cream
          background is invisible. */}
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]} edges={['top', 'bottom']}>
        {mesh.phase === 'booting' && <Booting />}
        {mesh.phase === 'onboarding' && (
          <OnboardingScreen suggestedName={mesh.suggestedName} onCreate={mesh.create} />
        )}
        {mesh.phase === 'error' && <Failed reason={mesh.error} />}
        {mesh.phase === 'ready' && <MeshScreen mesh={mesh} />}
      </SafeAreaView>
    </>
  );
}

function Booting() {
  const { theme, accent } = useTheme();
  return (
    <View style={styles.centre}>
      <ActivityIndicator color={accent} />
      <Text style={[styles.centreText, { color: theme.dim }]}>Opening the radio…</Text>
    </View>
  );
}

/**
 * Every way this can fail is something the user can act on — Bluetooth off, a
 * permission denied, a chipset with no peripheral role — so the reason is shown
 * verbatim rather than collapsed into "something went wrong".
 */
function Failed({ reason }: { reason: string }) {
  const { theme } = useTheme();
  return (
    <View style={styles.centre}>
      <Text style={[styles.failTitle, { color: theme.danger }]}>MeshNet could not start</Text>
      <Text style={[styles.centreText, { color: theme.dim }]}>{reason}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xxl,
    gap: space.md,
  },
  centreText: { ...typography.body, textAlign: 'center' },
  failTitle: { ...typography.title, textAlign: 'center' },
});
