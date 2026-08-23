import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { useMesh } from '../useMesh';
import { useTheme } from '../ThemeProvider';
import { type SchemePreference, bytes, space } from '../theme';
import { Button, Chip } from './Controls';
import { Stat } from './Stat';
import { IdentityPanel } from './IdentityPanel';
import { MODELS, type ModelSpec, formatBytes } from '../../llm/models';

type Mesh = ReturnType<typeof useMesh>;

const BUDGETS = [
  { label: '16 KB', bytes: 16 * 1024 },
  { label: '128 KB', bytes: 128 * 1024 },
  { label: '1 MB', bytes: 1024 * 1024 },
  { label: '8 MB', bytes: 8 * 1024 * 1024 },
];

export function NodeTab({ mesh }: { mesh: Mesh }) {
  const { styles, theme, accent } = useTheme();
  const r = mesh.replication;
  const used = mesh.catalogStats.metaBytes + mesh.catalogStats.bodyBytes;
  const budget = r?.budgetBytes ?? 0;
  const pct = budget ? Math.min(100, (used / budget) * 100) : 0;
  const metaShare = used ? Math.round((mesh.catalogStats.metaBytes / used) * 100) : 0;
  const known = mesh.catalogStats.known;
  const phase = mesh.llmStatus.phase;

  return (
    <ScrollView contentContainerStyle={styles.listPad}>
      <IdentityPanel mesh={mesh} />

      <Text style={styles.sectionTitle}>STORAGE — TWO TIERS</Text>
      <View style={[styles.card, r?.underPressure && styles.cardWarn]}>
        <Text style={styles.lede}>
          Metadata is what makes a passage findable; the body is what makes it readable. Holding
          the first everywhere is cheap, so this node knows about far more than it stores.
        </Text>

        {/* Two tiers, two colours: `info` for what this node merely knows
            about, the tab's own hue for what it actually holds. The bars are
            measuring different things and reading them as one stacked quantity
            is the misunderstanding this whole panel exists to prevent. */}
        <View style={styles.tierRow}>
          <Text style={styles.tierLabel}>knows</Text>
          <View style={styles.tierBar}>
            <View style={[styles.tierFill, { width: '100%', backgroundColor: theme.info }]} />
          </View>
          <Text style={styles.tierValue}>
            {known} psg · {bytes(mesh.catalogStats.metaBytes)}
          </Text>
        </View>
        <View style={styles.tierRow}>
          <Text style={styles.tierLabel}>stores</Text>
          <View style={styles.tierBar}>
            <View
              style={[
                styles.tierFill,
                {
                  width: `${known ? (mesh.catalogStats.stored / known) * 100 : 0}%`,
                  backgroundColor: accent,
                },
              ]}
            />
          </View>
          <Text style={styles.tierValue}>
            {mesh.catalogStats.stored} psg · {bytes(mesh.catalogStats.bodyBytes)}
          </Text>
        </View>

        <View style={styles.progress}>
          <View
            style={[
              styles.progressFill,
              { width: `${pct}%`, backgroundColor: r?.underPressure ? theme.warn : accent },
            ]}
          />
        </View>
        <Text style={styles.hint}>
          {bytes(used)} of {bytes(budget)} budget · metadata is {metaShare}% of it
          {r?.underPressure ? ' · OVER BUDGET' : ''}
        </Text>

        {/*
          The honest note the web build makes, and it is worth repeating on a
          phone: metadata is a *fixed* ~620 bytes, 384 of which is the
          embedding. On the short first-aid passages here that is nearly half a
          body, so wide metadata replication is barely cheaper than wide body
          replication. The structural argument does not depend on the ratio —
          discovery stays available when the nodes holding the content do not.
        */}
      </View>

      <Text style={styles.sectionTitle}>STORAGE BUDGET</Text>
      <View style={styles.card}>
        <Text style={styles.lede}>
          Shrink it and this node goes over budget immediately, sheds every body it can, and
          settles as a metadata-only node. Search from it afterwards: the results still come back,
          badged with whoever holds the text.
        </Text>
        <View style={styles.chipRow}>
          {BUDGETS.map((b) => (
            <Chip
              key={b.bytes}
              label={b.label}
              on={budget === b.bytes}
              onPress={() => void mesh.setBudget(b.bytes)}
            />
          ))}
        </View>
      </View>

      <Appearance />

      <Text style={styles.sectionTitle}>REPLICATION</Text>
      <View style={styles.card}>
        {r ? (
          <>
            <Stat label="bodies pulled" value={r.pulls} />
            <Stat label="bodies evicted" value={r.evictions} />
            <Stat label="below target" value={r.underReplicated} />
            <Stat label="one live copy only" value={r.atRisk} />
            <Text style={styles.hint}>
              placement: weighted rendezvous hashing · target: popularity and observed reliability
            </Text>
            {r.atRisk > 0 && mesh.peers.length > 0 && (
              <Text style={[styles.hint, { color: theme.warn }]}>
                {r.atRisk} passage{r.atRisk === 1 ? '' : 's'} have only one live copy.
              </Text>
            )}
          </>
        ) : (
          <Text style={styles.cardBody}>waiting for the first pass</Text>
        )}
      </View>

      <Text style={styles.sectionTitle}>SEARCH AND ANSWERS</Text>
      <View style={styles.card}>
        <Stat label="embedder" value={0} render="hashing · 384d · no download" />
        <Stat label="generator" value={0} render={generatorLabel(mesh)} />
        {(phase === 'downloading' || phase === 'loading') && (
          <View style={styles.progress}>
            <View
              style={[
                styles.progressFill,
                {
                  width: `${Math.round(mesh.llmStatus.progress * 100)}%`,
                  backgroundColor: accent,
                },
              ]}
            />
          </View>
        )}
        {!!mesh.llmStatus.detail && <Text style={styles.hint}>{mesh.llmStatus.detail}</Text>}
        <Text style={styles.hint}>
          Answers are generated on this phone from the passages the mesh returned — the model is
          never the source. Without one, answers are the retrieved sentences that best match the
          question, which cannot invent a dosage. Every hit says which mode produced it.
        </Text>

        {phase === 'downloading' ? (
          <Button
            label="Cancel download"
            icon="close-circle-outline"
            variant="ghost"
            onPress={mesh.cancelLlmFetch}
            style={{ marginTop: space.md }}
          />
        ) : phase === 'unavailable' ? (
          <Text style={styles.hint}>
            This binary was built before on-device models were added. Rebuild with{' '}
            <Text style={styles.statValue}>npm run android</Text> to enable them.
          </Text>
        ) : (
          <ModelShelf mesh={mesh} />
        )}
      </View>
    </ScrollView>
  );
}

/**
 * Light, dark, or whatever the phone says.
 *
 * Worth a control rather than following the system unconditionally, because
 * both overrides have a real field justification: forcing light beats a dark
 * screen in direct sun, and forcing dark saves an OLED panel real current when
 * the grid is down and the charge has to last. The choice survives a restart —
 * it goes in the catalog's key/value table, the same place the node's own
 * settings live.
 */
function Appearance() {
  const { styles, theme, preference, setPreference } = useTheme();

  const options: { label: string; value: SchemePreference }[] = [
    { label: 'System', value: null },
    { label: 'Light', value: 'light' },
    { label: 'Dark', value: 'dark' },
  ];

  return (
    <>
      <Text style={styles.sectionTitle}>APPEARANCE</Text>
      <View style={styles.card}>
        <View style={[styles.chipRow, { marginTop: 0 }]}>
          {options.map((o) => (
            <Chip
              key={o.label}
              label={o.label}
              on={preference === o.value}
              onPress={() => setPreference(o.value)}
            />
          ))}
        </View>
        <Text style={styles.hint}>
          Currently {theme.scheme}
          {preference === null ? ', following this phone' : ', set here'}. Each tab carries its own
          colour, so the section you are on is legible before you have read a word.
        </Text>
      </View>
    </>
  );
}

/**
 * Which models are on this device, which can be fetched, and what the one
 * loaded right now is doing.
 *
 * This was previously two lists of the same thing: a stack of `LOAD <name>`
 * buttons at the top and a stack of `<name> · DELETE` rows at the bottom, so
 * every installed model appeared twice in two different idioms. Worse, the load
 * buttons were not telling the truth — `llm.load()` opens `installed()[0]` and
 * ignores which one was tapped, so three buttons all did the same thing while
 * appearing to offer a choice.
 *
 * One row per model fixes both: the row is the model, it carries its own
 * actions, and loading is a single labelled command that names the file it will
 * actually open.
 */
function ModelShelf({ mesh }: { mesh: Mesh }) {
  const { styles, theme } = useTheme();
  const installed = mesh.llmModels;
  const loaded = mesh.llmStatus.phase === 'ready';
  const busy = mesh.llmStatus.phase === 'loading';
  const first = installed[0];
  const missing = MODELS.filter((spec) => !installed.some((m) => sameModel(m.name, spec)));

  return (
    <View style={{ marginTop: space.md, gap: space.md }}>
      {loaded ? (
        <Button
          label="Unload — free the memory"
          icon="stop-circle-outline"
          variant="ghost"
          onPress={() => void mesh.unloadLlm()}
        />
      ) : first ? (
        // Names the file it will open, because it opens that one regardless of
        // which row you came from.
        <Button
          label={`Load ${first.name}`}
          icon="play-outline"
          busy={busy}
          onPress={() => void mesh.loadLlm()}
        />
      ) : null}

      {installed.length > 0 && (
        <View style={{ gap: space.xs }}>
          <Text style={styles.sectionTitle}>ON THIS DEVICE</Text>
          {installed.map((m) => (
            <View key={m.name} style={[shelf.row, { borderBottomColor: theme.hairline }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.statLabel} numberOfLines={1}>
                  {m.name}
                </Text>
                <Text style={[styles.hint, { marginTop: 0 }]}>{formatBytes(m.bytes)}</Text>
              </View>
              <Button
                label="Delete"
                variant="danger"
                compact
                onPress={() => void mesh.removeLlm(m.name)}
              />
            </View>
          ))}
        </View>
      )}

      {missing.length > 0 && (
        <View style={{ gap: space.xs }}>
          <Text style={styles.sectionTitle}>AVAILABLE TO DOWNLOAD</Text>
          {missing.map((spec) => (
            <View key={spec.id} style={[shelf.row, { borderBottomColor: theme.hairline }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.statLabel} numberOfLines={1}>
                  {spec.name}
                </Text>
                {/* The note and the parameter count are the two things someone
                    deciding whether to spend the bandwidth actually needs, and
                    both were already in MODELS without ever reaching a screen. */}
                <Text style={[styles.hint, { marginTop: 0 }]}>
                  {spec.params} · {formatBytes(spec.bytes)} · {spec.license}
                </Text>
                <Text style={[styles.hint, { marginTop: 2 }]}>{spec.note}</Text>
              </View>
              <Button
                label="Get"
                variant="ghost"
                compact
                onPress={() => void mesh.fetchLlm(spec)}
              />
            </View>
          ))}
        </View>
      )}

      <Button
        label="Open a .gguf from this device"
        icon="folder-open-outline"
        variant="ghost"
        onPress={() => void mesh.importLlm()}
      />
      <Text style={[styles.hint, { marginTop: 0 }]}>
        Downloading needs a network this once. Opening a file does not — a model can arrive over
        USB or from another phone, which is the only route that works where this app is meant to be
        used.
      </Text>
    </View>
  );
}

/**
 * Installed models are stored under a filename, not a spec id, so matching is
 * by the loose shape of the name rather than by equality.
 */
function sameModel(installedName: string, spec: ModelSpec): boolean {
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return flat(installedName).includes(flat(spec.id)) || flat(spec.id).includes(flat(installedName));
}

/** One model per row. The rule colour arrives from the palette at the call site. */
const shelf = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});

function generatorLabel(mesh: Mesh): string {
  const { phase, progress, model } = mesh.llmStatus;
  if (phase === 'ready') return model ? `${model} · on device` : 'on-device model ready';
  if (phase === 'generating') return 'generating';
  if (phase === 'downloading') return `downloading — ${Math.round(progress * 100)}%`;
  if (phase === 'loading') return `loading — ${Math.round(progress * 100)}%`;
  if (phase === 'error') return 'failed — extractive mode';
  return 'extractive mode';
}
