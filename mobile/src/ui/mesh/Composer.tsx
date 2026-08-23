import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  BackHandler,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';

import { parseDocument } from '@core/lib/chunk';

import type { useMesh } from '../useMesh';
import { useTheme } from '../ThemeProvider';
import { motion, space, TAP_TARGET } from '../theme';
import { Button } from './Controls';

type Mesh = ReturnType<typeof useMesh>;

/**
 * Where a document is written, whether or not a keyboard produced it.
 *
 * Importing a file lands its text *here* rather than on the mesh, which is the
 * whole reason there is one screen instead of two. Publishing is irreversible
 * in the only sense that matters on a mesh: `forget` clears this node, and every
 * phone that already pulled a body keeps it. So the last thing that happens
 * before text leaves is a person looking at it.
 *
 * It is a plain absolutely-positioned view rather than a `Modal` on purpose. A
 * Modal is its own Android window and does not inherit the activity's
 * `adjustResize`, so the keyboard would sit on top of the body field — the one
 * thing this screen exists to show.
 */
export function Composer({ mesh, onClose }: { mesh: Mesh; onClose: () => void }) {
  const { styles, theme, accent } = useTheme();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [focus, setFocus] = useState<'title' | 'body' | null>(null);
  const [error, setError] = useState('');

  const busy = mesh.upload.busy;
  const dirty = !!title.trim() || !!body.trim();
  const ready = !!title.trim() && !!body.trim();

  const anim = useRef(new Animated.Value(0)).current;
  // Guards the exit: a second dismiss mid-animation would fire `onClose` twice
  // and, on the back button, unmount the tab underneath as well.
  const leaving = useRef(false);

  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: motion.base,
      easing: motion.ease,
      useNativeDriver: true,
    }).start();
  }, [anim]);

  const dismiss = () => {
    if (leaving.current) return;
    leaving.current = true;
    Animated.timing(anim, {
      toValue: 0,
      duration: motion.fast,
      easing: motion.easeIn,
      useNativeDriver: true,
    }).start(() => onClose());
  };

  /** Nothing typed leaves without being asked about. */
  const close = () => {
    if (busy) return;
    if (!dirty) return dismiss();
    Alert.alert('Discard this document?', 'It has not been published to the mesh.', [
      { text: 'Keep writing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: dismiss },
    ]);
  };

  // Back is a dismiss, not a navigation — without this it would drop straight
  // out of the app from a screen with unsaved text on it. Registered once and
  // called through a ref: re-subscribing on every keystroke to keep the closure
  // fresh would churn a listener per character typed.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeRef.current();
      return true;
    });
    return () => sub.remove();
  }, []);

  /**
   * What this will actually become in the catalog.
   *
   * Run through the real parser rather than estimated from a word count: the
   * number shown is the number of passages that will be embedded, announced and
   * ranked, and a rule-of-thumb that disagreed with the pipeline would be worse
   * than saying nothing.
   */
  const passages = useMemo(() => {
    const text = body.trim();
    if (!text) return 0;
    return parseDocument(fileNameFor(title), text, title.trim() || undefined).chunks.length;
  }, [body, title]);

  const publish = async () => {
    setError('');
    try {
      await mesh.addFiles([
        { name: fileNameFor(title), text: body, title: title.trim() },
      ]);
      dismiss();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const importFile = async () => {
    if (body.trim()) {
      const ok = await confirm(
        'Replace what you have written?',
        'Importing a file overwrites the text on this screen.',
        'Replace',
      );
      if (!ok) return;
    }
    const result = await DocumentPicker.getDocumentAsync({
      multiple: false,
      copyToCacheDirectory: true,
      type: ['text/plain', 'text/markdown', 'text/*'],
    });
    if (result.canceled || !result.assets?.length) return;

    const asset = result.assets[0] as { name?: string; uri: string };
    setError('');
    try {
      const text = await readAssetText(asset.uri);
      setBody(text);
      // The file's own name only wins where the author has not given one. A
      // markdown `# ` heading beats the filename, which is what `parseDocument`
      // already decides — so ask it rather than re-deriving it here and drifting.
      if (!title.trim()) setTitle(parseDocument(asset.name ?? 'document.txt', text).title);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFill,
        styles.composer,
        {
          opacity: anim,
          transform: [
            { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) },
          ],
        },
      ]}
    >
      <View style={styles.composerBar}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, flex: 1 }}>
          <Pressable
            onPress={close}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="close without publishing"
            android_ripple={{ color: `${theme.faint}2e`, borderless: true, radius: 22 }}
            style={({ pressed }) => [
              {
                width: TAP_TARGET,
                height: TAP_TARGET,
                alignItems: 'center',
                justifyContent: 'center',
              },
              (pressed || busy) && { opacity: 0.45 },
            ]}
          >
            <Ionicons name="close" size={22} color={theme.dim} />
          </Pressable>
          <Text style={styles.composerBarTitle}>NEW DOCUMENT</Text>
        </View>

        <Button
          label="Publish"
          icon="arrow-up-circle-outline"
          compact
          busy={busy}
          disabled={!ready}
          onPress={() => void publish()}
        />
      </View>

      <View style={{ flex: 1, paddingHorizontal: space.lg, paddingTop: space.md }}>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder="Title — what is this?"
          placeholderTextColor={theme.faint}
          style={[styles.composerTitle, focus === 'title' && { borderColor: accent }]}
          onFocus={() => setFocus('title')}
          onBlur={() => setFocus(null)}
          returnKeyType="next"
          maxLength={TITLE_MAX}
          autoFocus
        />
        {/* Borderless, and the only thing on screen set at reading size: this is
            text being written, not a field being filled in. */}
        <TextInput
          value={body}
          onChangeText={setBody}
          placeholder="What do you know that the mesh does not? Local conditions, a route, a dosage, an address — anything a phone with no signal should be able to answer from."
          placeholderTextColor={theme.faint}
          style={styles.composerBody}
          onFocus={() => setFocus('body')}
          onBlur={() => setFocus(null)}
          multiline
          textAlignVertical="top"
          scrollEnabled
        />
      </View>

      <View style={styles.composerFoot}>
        {busy && (
          <View>
            <View style={[styles.progress, { marginTop: 0 }]}>
              <View
                style={[
                  styles.progressFill,
                  {
                    width: `${
                      mesh.upload.total ? (mesh.upload.done / mesh.upload.total) * 100 : 0
                    }%`,
                    backgroundColor: accent,
                  },
                ]}
              />
            </View>
            <Text style={styles.hint}>
              {mesh.upload.label}
              {mesh.upload.total
                ? ` — ${mesh.upload.done}/${mesh.upload.total} passages embedded`
                : ''}
            </Text>
          </View>
        )}

        {!!error && (
          <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' }}>
            <Ionicons name="alert-circle-outline" size={14} color={theme.warn} />
            <Text style={[styles.hint, { marginTop: 0, flex: 1, color: theme.warn }]}>{error}</Text>
          </View>
        )}

        <Text style={[styles.hint, { marginTop: 0 }]}>
          Publishing spreads this to every phone in range. Forgetting it later only clears this
          one.
        </Text>

        <View style={styles.composerActions}>
          <Button
            label="Import .txt or .md"
            icon="file-tray-outline"
            variant="ghost"
            compact
            disabled={busy}
            onPress={() => void importFile()}
          />
          <Text style={styles.composerCount}>
            {body.trim()
              ? `${body.trim().length} chars · ${passages} passage${passages === 1 ? '' : 's'}`
              : 'empty'}
          </Text>
        </View>
      </View>
    </Animated.View>
  );
}

/** Long enough for a real sentence, short enough to survive a one-line row. */
const TITLE_MAX = 80;

/**
 * A filename for text that never had one.
 *
 * Only `source` is riding on this now — the title the author typed is passed
 * separately and no longer inferred from here — so it exists to say where the
 * document came from, not to name it.
 */
function fileNameFor(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${slug || 'note'}.md`;
}

async function readAssetText(uri: string): Promise<string> {
  const response = await fetch(uri);
  if (!response.ok) throw new Error(`could not read document: ${response.status}`);
  return response.text();
}

/** `Alert.alert` as something that can be awaited. */
function confirm(title: string, message: string, proceed: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: proceed, style: 'destructive', onPress: () => resolve(true) },
      ],
      // Android dismisses on an outside tap without running any button's
      // handler, which would leave the caller awaiting a promise forever.
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
