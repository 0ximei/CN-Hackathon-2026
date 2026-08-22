import React, { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';

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
      <View style={styles.searchBar}>
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
          style={[styles.button, (mesh.searching || !text.trim()) && styles.buttonBusy]}
        >
          {mesh.searching ? (
            <ActivityIndicator color={theme.bg} size="small" />
          ) : (
            <Text style={styles.buttonText}>ASK</Text>
          )}
        </Pressable>
      </View>

      <View style={[styles.chipRow, { paddingHorizontal: 12, marginTop: 0, marginBottom: 6 }]}>
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

      {!!summary && <Text style={styles.summary}>{summary}</Text>}

      <FlatList
        data={hits}
        keyExtractor={(h) => String(h.docId)}
        contentContainerStyle={styles.listPad}
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
      <View style={styles.card}>
        <View style={styles.hitTop}>
          <Text style={styles.cardTitle}>Answer</Text>
          <Text style={styles.hitBadge}>flooding query</Text>
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

  return (
    <View style={{ gap: 10 }}>
      <View style={styles.card}>
        <View style={styles.hitTop}>
          <Text style={styles.cardTitle}>Answer</Text>
          <Text style={styles.hitBadge}>
            {mesh.answer?.mode === 'generated'
              ? 'on-device LLM'
              : mesh.answering
                ? 'generating'
                : 'extractive'}
          </Text>
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
