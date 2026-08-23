import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { useMesh } from '../useMesh';
import { useTheme } from '../ThemeProvider';
import { motion, space, typography } from '../theme';
import { Chip, Empty } from './Controls';
import { HitRow } from './HitRow';

type Mesh = ReturnType<typeof useMesh>;

const EXAMPLES = [
  'how long do I cool a burn',
  'someone stopped shivering in the cold',
  'what do I do for a snake bite',
  'is the water safe to drink',
];

export function SearchTab({ mesh }: { mesh: Mesh }) {
  const { styles, theme, accent } = useTheme();
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const hits = mesh.query?.hits ?? [];

  const summary = useMemo(() => {
    if (!mesh.query) return '';
    const local = hits.filter((h) => h.local).length;
    const remote = hits.length - local;
    const fetched = hits.filter((h) => !h.storedHere && h.text).length;
    const metaOnly = hits.filter((h) => !h.storedHere && !h.text).length;
    const parts = [`${local} local`];
    if (remote) parts.push(`${remote} from mesh`);
    if (fetched) parts.push(`${fetched} body fetched`);
    if (metaOnly) parts.push(`${metaOnly} snippet only`);
    if (mesh.query.finishedAt) {
      parts.push(`${((mesh.query.finishedAt - mesh.query.startedAt) / 1000).toFixed(1)}s`);
    }
    return parts.join(' · ');
  }, [hits, mesh.query]);

  const ask = (q: string) => {
    setText(q);
    void mesh.search(q);
  };

  // Two different unavailables, shown differently on purpose: nothing typed yet
  // is a dead control and looks it, whereas a search already in flight is very
  // much alive and only needs to refuse a second tap.
  const empty = !text.trim();
  const cannotSearch = mesh.searching || empty;

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          paddingHorizontal: space.lg,
          paddingTop: space.md,
          paddingBottom: space.md,
          gap: space.md,
        }}
      >
        <Text style={styles.heroLede}>You&rsquo;re offline — but not without help.</Text>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="how do I treat a burn"
            placeholderTextColor={theme.faint}
            style={[styles.input, focused && { borderColor: accent }]}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            returnKeyType="search"
            onSubmitEditing={() => void mesh.search(text)}
          />
          {/* Square, because it is the input's own action rather than a
              statement in its own right — a labelled slab beside a field reads
              as a second, competing control. */}
          <Pressable
            onPress={() => void mesh.search(text)}
            disabled={cannotSearch}
            accessibilityRole="button"
            accessibilityLabel="search the mesh"
            accessibilityState={{ disabled: cannotSearch, busy: mesh.searching }}
            android_ripple={
              cannotSearch ? undefined : { color: `${theme.onAccent}33`, borderless: false }
            }
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: accent, paddingHorizontal: space.lg, minWidth: 52 },
              empty && styles.buttonDisabled,
              pressed && !cannotSearch && { opacity: 0.7, transform: [{ scale: 0.98 }] },
            ]}
          >
            {mesh.searching ? (
              <PulseIcon>
                <Ionicons name="search-outline" size={18} color={theme.onAccent} />
              </PulseIcon>
            ) : (
              <Ionicons name="search-outline" size={18} color={theme.onAccent} />
            )}
          </Pressable>
        </View>

        <View style={[styles.chipRow, { marginTop: 0 }]}>
          {EXAMPLES.map((ex) => (
            <Chip key={ex} label={ex} onPress={() => ask(ex)} disabled={mesh.searching} />
          ))}
        </View>
      </View>

      {!!summary && <Text style={styles.summary}>{summary}</Text>}

      <FlatList
        data={hits}
        keyExtractor={(h) => String(h.docId)}
        contentContainerStyle={[styles.listPad, { paddingHorizontal: space.lg }]}
        ListHeaderComponent={<AnswerCard mesh={mesh} />}
        renderItem={({ item }) => (
          <HitRow hit={item} onOpen={() => mesh.openHit(item.docId)} />
        )}
        ListEmptyComponent={
          mesh.searching || mesh.query ? null : (
            <Empty icon="chatbubble-ellipses-outline">
              Ask something. Passages this phone holds answer instantly; the rest of the mesh
              answers over Bluetooth, and a passage it only knows{' '}
              <Text style={{ color: theme.dim, fontStyle: 'italic' }}>about</Text> comes back with
              the name of whoever has it.
            </Empty>
          )
        }
      />
    </View>
  );
}

/**
 * Gentle breathing scale, for anything that should read as "working on it."
 *
 * On the shared easing rather than `Easing.ease` — the React Native default is
 * the same curve every generated interface reaches for, and the point of having
 * three named easings is that nothing falls through to it.
 */
function PulseIcon({ children }: { children: React.ReactNode }) {
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, {
          toValue: 1.18,
          duration: 650,
          easing: motion.easeInOut,
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1,
          duration: 650,
          easing: motion.easeInOut,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [scale]);

  return <Animated.View style={{ transform: [{ scale }] }}>{children}</Animated.View>;
}

type Mode = 'extractive' | 'generating' | 'generated';

/**
 * What produced the text on screen, made visible rather than just labelled.
 *
 * Both kinds of answer come from the mesh — that part is never in question, so
 * the badge doesn't say it. What actually varies, and what changes how much to
 * trust the words on screen, is *how* the answer was produced: a magnifying
 * glass for verbatim sentences lifted out of retrieved passages, versus
 * sparkles for a model's own paraphrase of them.
 */
function ModeBadge({ mode }: { mode: Mode }) {
  const { styles, theme, accent } = useTheme();

  // `info` for extractive, the tab's own hue for generated. The two have to be
  // told apart at a glance, and the pairing is deliberate: a verbatim passage
  // is a fact the mesh reported, so it takes the fixed informational colour,
  // while a generated answer is this app's own output and wears this app's
  // current colour.
  const config: Record<Mode, { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; color: string }> = {
    extractive: { icon: 'search-outline', label: 'verbatim passages', color: theme.info },
    generating: { icon: 'sparkles', label: 'thinking…', color: accent },
    generated: { icon: 'sparkles', label: 'AI-written', color: accent },
  };
  const { icon, label, color } = config[mode];
  const iconEl = <Ionicons name={icon} size={13} color={color} />;

  return (
    <View style={[styles.modeBadge, { backgroundColor: `${color}22` }]}>
      {mode === 'generating' ? <PulseIcon>{iconEl}</PulseIcon> : iconEl}
      <Text style={[styles.modeBadgeText, { color }]}>{label}</Text>
    </View>
  );
}

/**
 * The grounded answer, with its citations and its mode.
 *
 * The mode badge is not decoration. An extractive answer is sentences lifted
 * verbatim out of retrieved passages; a generated one is a model's words. Which
 * one produced the text on screen changes how much it should be trusted, so it
 * is stated rather than implied.
 */
function AnswerCard({ mesh }: { mesh: Mesh }) {
  const { styles, theme, accent } = useTheme();

  if (mesh.searching) {
    return (
      <View style={[styles.card, { marginBottom: space.md }]}>
        <View style={[styles.hitTop, { marginBottom: space.sm }]}>
          <Text style={styles.cardTitle}>Answer</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <PulseIcon>
              <Ionicons name="search-outline" size={14} color={theme.dim} />
            </PulseIcon>
            <Text style={[styles.hitBadge, { marginTop: 0 }]}>flooding query</Text>
          </View>
        </View>
        <Text style={styles.cardBody}>
          Waiting on the mesh — replies are collected until every known peer has answered, or six
          seconds, whichever comes first.
        </Text>
      </View>
    );
  }

  const text = mesh.answerText || mesh.answer?.text;
  if (!text) return null;

  const mode: Mode =
    mesh.answer?.mode === 'generated' ? 'generated' : mesh.answering ? 'generating' : 'extractive';

  return (
    <View style={{ marginBottom: space.md }}>
      <View
        style={[styles.card, mode !== 'extractive' && [styles.cardAccent, { borderColor: accent }]]}
      >
        <View style={[styles.hitTop, { marginBottom: space.sm }]}>
          <Text style={styles.cardTitle}>Answer</Text>
          <ModeBadge mode={mode} />
        </View>

        {/* The answer is what the whole app exists to put on screen, so it is
            set at reading size rather than at the 13px the supporting cards
            use. */}
        <Text style={[styles.cardBody, typography.body, { color: theme.text }]}>{text}</Text>

        {mesh.answer?.passages.length ? (
          <View style={{ marginTop: space.md, gap: space.xs }}>
            {mesh.answer.passages.map((p, i) => (
              <Text key={p.hit.docId} style={[styles.hitBadge, { marginTop: 0 }]}>
                [{i + 1}] {p.hit.title}
                {p.hit.section ? ` — ${p.hit.section}` : ''} ·{' '}
                {p.hit.local ? 'local' : `${p.hit.fromNodeName} · ${p.hit.hops}h`}
              </Text>
            ))}
          </View>
        ) : null}

        {/* Ruled off rather than dropped in as one more grey hint. It is the
            only sentence on this screen that is a caution rather than an
            explanation, and it should not be scannable as the same thing. */}
        <View
          style={{
            marginTop: space.md,
            paddingTop: space.md,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.hairline,
            flexDirection: 'row',
            gap: space.sm,
          }}
        >
          <Ionicons name="alert-circle-outline" size={14} color={theme.warn} />
          <Text style={[styles.hint, { marginTop: 0, flex: 1 }]}>
            Reference material for emergencies without connectivity. Not a substitute for
            professional medical care.
          </Text>
        </View>
      </View>
    </View>
  );
}
