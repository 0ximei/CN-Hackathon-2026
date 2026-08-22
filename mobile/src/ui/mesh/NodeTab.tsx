import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import type { useMesh } from '../useMesh';
import { styles } from './styles';
import { bytes, theme } from '../theme';
import { Stat } from './Stat';
import { IdentityPanel } from './IdentityPanel';

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
        <Stat
          label="generator"
          value={0}
          render={
            mesh.llmStatus.phase === 'ready'
              ? 'on-device model ready'
              : mesh.llmStatus.phase === 'loading'
                ? `${Math.round(mesh.llmStatus.progress * 100)}%`
                : 'extractive mode'
          }
        />
        <Text style={styles.hint}>
          The browser build runs MiniLM through transformers.js and answers with WebLLM. React
          Native has neither a Web Worker nor a threaded WASM runtime, so this is a hashing
          embedder blended with BM25 — instant, deterministic, and not semantic.
        </Text>
        {mesh.llmStatus.phase !== 'ready' && mesh.llmStatus.phase !== 'unavailable' && (
          <Pressable onPress={() => void mesh.loadLlm()} style={[styles.buttonGhost, { marginTop: 10 }]}>
            <Text style={styles.buttonGhostText}>TRY TO LOAD A LOCAL MODEL</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}
