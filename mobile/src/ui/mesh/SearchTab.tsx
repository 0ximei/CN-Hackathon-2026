import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { useMesh } from '../useMesh';
import { styles } from './styles';
import { theme } from '../theme';
import { HitRow } from './HitRow';

type Mesh = ReturnType<typeof useMesh>;

const EXAMPLES = [
  'how long do I cool a burn',
  'someone stopped shivering in the cold',
  'what do I do for a snake bite',
  'is the water safe to drink',
];

export function SearchTab({ mesh }: { mesh: Mesh }) {
  const [text, setText] = useState('');
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

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12, gap: 12 }}>
        <Text style={styles.heroLede}>You&rsquo;re offline — but not without help.</Text>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="how do I treat a burn"
            placeholderTextColor={theme.faint}
            style={styles.input}
            returnKeyType="search"
            onSubmitEditing={() => void mesh.search(text)}
          />
          <Pressable
            onPress={() => void mesh.search(text)}
            disabled={mesh.searching || !text.trim()}
            style={[
              styles.button,
              (mesh.searching || !text.trim()) && styles.buttonBusy,
              { paddingVertical: 13 },
            ]}
          >
            {mesh.searching ? (
              <PulseIcon>
                <Ionicons name="search-outline" size={18} color={theme.dim} />
              </PulseIcon>
            ) : (
              <Ionicons name="search-outline" size={18} color={theme.bg} />
            )}
          </Pressable>
        </View>

        <View style={[styles.chipRow, { marginTop: 0 }]}>
          {EXAMPLES.map((ex) => (
            <Pressable
              key={ex}
              onPress={() => ask(ex)}
              disabled={mesh.searching}
              style={styles.chip}
            >
              <Text style={styles.chipText} numberOfLines={1}>
                {ex}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {!!summary && <Text style={styles.summary}>{summary}</Text>}

      <FlatList
        data={hits}
        keyExtractor={(h) => String(h.docId)}
        contentContainerStyle={[styles.listPad, { paddingHorizontal: 16 }]}
        ListHeaderComponent={<AnswerCard mesh={mesh} />}
        renderItem={({ item }) => (
          <HitRow hit={item} onOpen={() => mesh.openHit(item.docId)} />
        )}
        ListEmptyComponent={
          mesh.searching || mesh.query ? null : (
            <Text style={styles.empty}>
              Ask something. Passages this phone holds answer instantly; the rest of the mesh
              answers over Bluetooth, and a passage it only knows *about* comes back with the name
              of whoever has it.
            </Text>
          )
        }
      />
    </View>
  );
}

/** Gentle breathing scale, for anything that should read as "working on it." */
function PulseIcon({ children }: { children: React.ReactNode }) {
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, {
          toValue: 1.2,
          duration: 650,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1,
          duration: 650,
          easing: Easing.inOut(Easing.ease),
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
  const config: Record<Mode, { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; color: string; bg: string }> = {
    extractive: { icon: 'search-outline', label: 'verbatim passages', color: theme.link, bg: 'rgba(124,134,245,0.16)' },
    generating: { icon: 'sparkles', label: 'thinking…', color: theme.accent, bg: theme.accentDim },
    generated: { icon: 'sparkles', label: 'AI-written', color: theme.accent, bg: theme.accentDim },
  };
  const { icon, label, color, bg } = config[mode];
  const iconEl = <Ionicons name={icon} size={13} color={color} />;

  return (
    <View style={[styles.modeBadge, { backgroundColor: bg }]}>
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
  if (mesh.searching) {
    return (
      <View style={[styles.card, { marginBottom: 10 }]}>
        <View style={[styles.hitTop, { marginBottom: 8 }]}>
          <Text style={styles.cardTitle}>Answer</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <PulseIcon>
              <Ionicons name="search-outline" size={14} color={theme.dim} />
            </PulseIcon>
            <Text style={styles.hitBadge}>flooding query</Text>
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
    <View style={{ gap: 10, marginBottom: 10 }}>
      <View style={[styles.card, mode !== 'extractive' && styles.cardAccent]}>
        <View style={[styles.hitTop, { marginBottom: 8 }]}>
          <Text style={styles.cardTitle}>Answer</Text>
          <ModeBadge mode={mode} />
        </View>
        <Text style={styles.cardBody}>{text}</Text>

        {mesh.answer?.passages.length ? (
          <View style={{ marginTop: 10, gap: 4 }}>
            {mesh.answer.passages.map((p, i) => (
              <Text key={p.hit.docId} style={styles.hitBadge}>
                [{i + 1}] {p.hit.title}
                {p.hit.section ? ` — ${p.hit.section}` : ''} ·{' '}
                {p.hit.local ? 'local' : `${p.hit.fromNodeName} · ${p.hit.hops}h`}
              </Text>
            ))}
          </View>
        ) : null}

        <Text style={[styles.hint, { color: theme.faint }]}>
          Reference material for emergencies without connectivity. Not a substitute for
          professional medical care.
        </Text>
      </View>
    </View>
  );
}
