import React, { useEffect, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';

import { cleanName } from '../identity/identity';
import { Button } from './mesh/Controls';
import { useTheme } from './ThemeProvider';
import { space } from './theme';

/**
 * First launch: create this device's identity.
 *
 * The node id is a hash of an Ed25519 public key, so this screen is not a
 * formality — it is where the key that every later signature, holder record and
 * BLE dial/wait tie-break depends on gets generated. That is also why it comes
 * before the radio starts rather than after: a node cannot begin routing under
 * an id it does not have yet.
 *
 * The only thing asked of the user is a name, because it is the only part a
 * person can meaningfully choose. Everything that matters is derived.
 */
export function OnboardingScreen({
  suggestedName,
  onCreate,
}: {
  suggestedName: string;
  onCreate: (name: string) => void;
}) {
  const { styles, theme, accent } = useTheme();
  const [name, setName] = useState('');
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (suggestedName) setName((current) => current || suggestedName);
  }, [suggestedName]);

  const submit = () => {
    if (busy) return;
    setBusy(true);
    onCreate(cleanName(name) || suggestedName);
  };

  return (
    <ScrollView contentContainerStyle={styles.onboard} keyboardShouldPersistTaps="handled">
      <Text style={styles.onboardTitle}>Create this node</Text>
      <Text style={styles.onboardBody}>
        MeshNet has no accounts and no server to register with — there is nothing to sign in to,
        offline. Instead this device generates a keypair, and its address on the mesh is a hash of
        the public half.
      </Text>
      <Text style={styles.onboardBody}>
        That makes the id self-certifying: any node can challenge this one to sign a random number,
        and only the phone holding the private key can answer. Nobody can route under your id or
        attribute a passage to you without it.
      </Text>

      <Text style={[styles.sectionTitle, { marginTop: space.xl }]}>DISPLAY NAME</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        maxLength={24}
        autoCapitalize="words"
        autoCorrect={false}
        placeholder={suggestedName || 'Kamo'}
        placeholderTextColor={theme.faint}
        style={[styles.input, focused && { borderColor: accent }]}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      <Text style={styles.hint}>
        Shown beside every result your phone answers. It travels inside the signature, so a node
        cannot prove one name and display another — but a name is not unique and never proves
        anything on its own. Two phones compare fingerprints for that.
      </Text>

      <Button
        label="Generate keypair"
        icon="key-outline"
        busy={busy}
        onPress={submit}
        style={{ marginTop: space.xl }}
      />

      <View style={[styles.card, { marginTop: space.xl }]}>
        <Text style={styles.cardTitle}>Where the key lives</Text>
        <Text style={styles.cardBody}>
          In this app&rsquo;s own SQLite file, in private app storage. The Android Keystore is where
          it belongs and would keep it off the JS heap entirely; signing happens in JavaScript here,
          so it cannot. Treat this as a demo credential, not a durable one.
        </Text>
      </View>
    </ScrollView>
  );
}
