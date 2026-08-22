import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import type { useMesh } from '../useMesh';
import { styles } from './styles';
import { bytes, theme } from '../theme';
import { Stat } from './Stat';
import { IdentityPanel } from './IdentityPanel';
import { MODELS, formatBytes } from '../../llm/models';

type Mesh = ReturnType<typeof useMesh>;

const BUDGETS = [
  { label: '16 KB', bytes: 16 * 1024 },
  { label: '128 KB', bytes: 128 * 1024 },
  { label: '1 MB', bytes: 1024 * 1024 },
  { label: '8 MB', bytes: 8 * 1024 * 1024 },
];

const COVERAGES = [0.35, 0.6, 1];

export function NodeTab({ mesh }: { mesh: Mesh }) {
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

        <View style={styles.tierRow}>
          <Text style={styles.tierLabel}>knows</Text>
          <View style={styles.tierBar}>
            <View style={[styles.tierFillMeta, { width: '100%' }]} />
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
                styles.tierFillBody,
                { width: `${known ? (mesh.catalogStats.stored / known) * 100 : 0}%` },
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
              { width: `${pct}%`, backgroundColor: r?.underPressure ? theme.warn : theme.accent },
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
            <Pressable
              key={b.bytes}
              onPress={() => void mesh.setBudget(b.bytes)}
              style={[styles.chip, budget === b.bytes && styles.chipOn]}
            >
              <Text style={[styles.chipText, budget === b.bytes && styles.chipTextOn]}>
                {b.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

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

      <Text style={styles.sectionTitle}>BUILT-IN CORPUS SLICE</Text>
      <View style={styles.card}>
        <Text style={styles.cardBody}>
          Every node gets metadata for the whole sample corpus and the bodies for part of it, so a
          search has something to go looking for instead of always answering locally.
          {mesh.seedReport
            ? ` This node kept ${mesh.seedReport.bodiesKept} of ${mesh.seedReport.chunksTotal} passages.`
            : ''}
        </Text>
        <View style={styles.chipRow}>
          {COVERAGES.map((value) => {
            const on = Math.abs(mesh.coverage - value) < 0.01;
            return (
              <Pressable
                key={value}
                onPress={() => void mesh.changeCoverage(value)}
                style={[styles.chip, on && styles.chipOn]}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>
                  {value === 1 ? 'everything' : `${Math.round(value * 100)}%`}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <Text style={styles.sectionTitle}>SEARCH AND ANSWERS</Text>
      <View style={styles.card}>
        <Stat label="embedder" value={0} render="hashing · 384d · no download" />
        <Stat label="generator" value={0} render={generatorLabel(mesh)} />
        {(phase === 'downloading' || phase === 'loading') && (
          <View style={styles.progress}>
            <View style={[styles.progressFill, { width: `${Math.round(mesh.llmStatus.progress * 100)}%` }]} />
          </View>
        )}
        {!!mesh.llmStatus.detail && <Text style={styles.hint}>{mesh.llmStatus.detail}</Text>}
        <Text style={styles.hint}>
          Answers are generated on this phone from the passages the mesh returned — the model is
          never the source. Without one, answers are the corpus sentences that best match the
          question, which cannot invent a dosage. Every hit says which mode produced it.
        </Text>

        {phase === 'downloading' ? (
          <Pressable onPress={mesh.cancelLlmFetch} style={[styles.buttonGhost, { marginTop: 10 }]}>
            <Text style={styles.buttonGhostText}>CANCEL DOWNLOAD</Text>
          </Pressable>
        ) : phase === 'ready' ? (
          <View style={{ marginTop: 10 }}>
            <Pressable onPress={() => void mesh.unloadLlm()} style={styles.buttonGhost}>
              <Text style={styles.buttonGhostText}>UNLOAD — FREE THE MEMORY</Text>
            </Pressable>
          </View>
        ) : phase === 'unavailable' ? (
          <Text style={styles.hint}>
            This binary was built before on-device models were added. Rebuild with{' '}
            <Text style={styles.statValue}>npm run android</Text> to enable them.
          </Text>
        ) : (
          <View style={{ marginTop: 10 }}>
            {mesh.llmModels.map((m) => (
              <Pressable key={m.name} onPress={() => void mesh.loadLlm()} style={[styles.buttonGhost, { marginBottom: 8 }]}>
                <Text style={styles.buttonGhostText}>
                  LOAD {m.name.toUpperCase()} · {formatBytes(m.bytes)}
                </Text>
              </Pressable>
            ))}
            {MODELS.map((spec) => (
              <Pressable
                key={spec.id}
                onPress={() => void mesh.fetchLlm(spec)}
                style={[styles.buttonGhost, { marginBottom: 8 }]}
              >
                <Text style={styles.buttonGhostText}>
                  DOWNLOAD {spec.name.toUpperCase()} · {formatBytes(spec.bytes)}
                </Text>
              </Pressable>
            ))}
            <Pressable onPress={() => void mesh.importLlm()} style={styles.buttonGhost}>
              <Text style={styles.buttonGhostText}>OPEN A .GGUF FROM THIS DEVICE</Text>
            </Pressable>
            <Text style={styles.hint}>
              Downloading needs a network this once. Opening a file does not — a model can arrive
              over USB or from another phone, which is the only route that works where this app is
              meant to be used.
            </Text>
          </View>
        )}

        {!!mesh.llmModels.length && phase !== 'downloading' && (
          <View style={{ marginTop: 12 }}>
            {mesh.llmModels.map((m) => (
              <View key={`installed-${m.name}`} style={styles.statRow}>
                <Text style={styles.statLabel} numberOfLines={1}>
                  {m.name}
                </Text>
                <Pressable onPress={() => void mesh.removeLlm(m.name)}>
                  <Text style={[styles.statValue, { color: theme.danger }]}>DELETE</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

function generatorLabel(mesh: Mesh): string {
  const { phase, progress, model } = mesh.llmStatus;
  if (phase === 'ready') return model ? `${model} · on device` : 'on-device model ready';
  if (phase === 'generating') return 'generating';
  if (phase === 'downloading') return `downloading — ${Math.round(progress * 100)}%`;
  if (phase === 'loading') return `loading — ${Math.round(progress * 100)}%`;
  if (phase === 'error') return 'failed — extractive mode';
  return 'extractive mode';
}
