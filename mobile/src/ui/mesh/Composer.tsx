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

import { parseDocument } from '@core/lib/chunk';

import type { useMesh } from '../useMesh';
import { useTheme } from '../ThemeProvider';
import { motion, space, TAP_TARGET } from '../theme';
import { Button } from './Controls';

type Mesh = ReturnType<typeof useMesh>;

/**
 * Where a document is written.
 *
 * Only written. Importing a file used to land its text here as a first draft,
 * on the reasoning that an author should proof an extraction before publishing
 * it — but a file somebody already has is not a draft, and asking them to read
 * fifty pages of recovered PDF text before it will move made importing the
 * slower of the two paths rather than the faster one. Importing now goes
 * straight to the mesh from the Files tab and this screen is for text that did
 * not exist until someone typed it.
 *
 * Publishing is still irreversible in the only sense that matters on a mesh:
 * `forget` clears this node, and every phone that already pulled a body keeps
 * it. That is why what is typed here gets a confirm on the way out.
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
          placeholder={
            'What do you know that the mesh does not? Local conditions, a route, a dosage, an address — anything a phone with no signal should be able to answer from.'
          }
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

        {/* Was one end of a row with an import button; on its own it just
            joins the stack of footer text above it. */}
        <Text style={styles.composerCount}>
          {body.trim()
            ? `${body.trim().length} chars · ${passages} passage${passages === 1 ? '' : 's'}`
            : 'empty'}
        </Text>
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
