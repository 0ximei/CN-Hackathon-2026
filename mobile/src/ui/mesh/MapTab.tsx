import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import type { useMesh } from '../useMesh';
import { styles } from './styles';
import { theme } from '../theme';
import { MeshGraph } from './MeshGraph';
import { PeerRow } from './PeerRow';
import { Stat } from './Stat';

type Mesh = ReturnType<typeof useMesh>;

/** Hop limits worth having a button for. TTL 1 makes distant nodes go silent. */
const TTLS = [1, 2, 4, 8];
const LOSSES = [0, 0.15, 0.3, 0.6];

export function MapTab({ mesh }: { mesh: Mesh }) {
  const caps = mesh.capabilities;

  return (
    <ScrollView contentContainerStyle={styles.listPad}>
      {mesh.identity && (
        <MeshGraph
          identity={mesh.identity}
          selfStored={mesh.catalogStats.stored}
          selfKnown={mesh.catalogStats.known}
          peers={mesh.peers}
          activity={mesh.activity}
          respondedNodeIds={mesh.query?.respondedNodeIds ?? []}
        />
      )}

      {caps && !caps.canAdvertise && (
        <View style={[styles.card, styles.cardWarn]}>
          <Text style={styles.cardTitle}>This phone cannot advertise</Text>
          <Text style={styles.cardBody}>
            Its Bluetooth chipset has no peripheral role, so scanners will never see it. It can
            still dial out and take part as a leaf node, but it cannot relay for anyone.
          </Text>
        </View>
      )}
      {caps && !caps.enabled && (
        <View style={[styles.card, styles.cardWarn]}>
          <Text style={styles.cardTitle}>Bluetooth is off</Text>
          <Text style={styles.cardBody}>Turn it on, then restart the app.</Text>
        </View>
      )}

      <Text style={styles.sectionTitle}>REACHABLE NODES</Text>
      {mesh.peers.length === 0 ? (
        <Text style={styles.empty}>
          No peers yet. Open MeshNet on a second Android phone within a few metres — discovery
          usually takes five to fifteen seconds.
        </Text>
      ) : (
        mesh.peers.map((peer) => (
          <PeerRow
            key={peer.nodeId}
            peer={peer}
            onVerify={() => mesh.challengePeer(peer.nodeId)}
          />
        ))
      )}

      <Text style={styles.sectionTitle}>TRAFFIC</Text>
      <View style={styles.card}>
        <Stat label="sent" value={mesh.stats.sent} />
        <Stat label="received" value={mesh.stats.received} />
        <Stat label="forwarded" value={mesh.stats.forwarded} />
        <Stat label="duplicates dropped" value={mesh.stats.duplicates} />
        <Stat label="dropped" value={mesh.stats.dropped} />
        <Stat label="parked for offline peers" value={mesh.outbox} />
      </View>

      <NetworkControls mesh={mesh} />
    </ScrollView>
  );
}

/**
 * The controls that exist to break the network on purpose, on stage.
 *
 * Sliders on the web; buttons here, because a slider inside a scroll view on a
 * phone fights the scroll gesture and there are only ever three or four values
 * anyone actually demonstrates.
 */
function NetworkControls({ mesh }: { mesh: Mesh }) {
  const patch = (next: Partial<typeof mesh.dev>) => mesh.setDev((d) => ({ ...d, ...next }));

  const directPeers = mesh.peers.filter((p) => p.hops <= 1);

  const toggleLink = (peerId: string) => {
    const cut = mesh.dev.cutLinks.includes(peerId)
      ? mesh.dev.cutLinks.filter((p) => p !== peerId)
      : [...mesh.dev.cutLinks, peerId];
    patch({ cutLinks: cut });
  };

  return (
    <>
      <Text style={styles.sectionTitle}>NETWORK CONTROLS</Text>
      <View style={styles.card}>
        <Text style={styles.lede}>
          Loss is injected between the radio and the router, and a cut link drops frames while the
          GATT connection stays up. So the recovery path that runs is the real one: the router
          relearns a route through a relay, or store-and-forward parks the packet until the node
          reappears.
        </Text>

        <Text style={styles.hint}>HOP LIMIT · TTL {mesh.dev.ttl}</Text>
        <View style={styles.chipRow}>
          {TTLS.map((ttl) => (
            <Pressable
              key={ttl}
              onPress={() => patch({ ttl })}
              style={[styles.chip, mesh.dev.ttl === ttl && styles.chipOn]}
            >
              <Text style={[styles.chipText, mesh.dev.ttl === ttl && styles.chipTextOn]}>
                {ttl}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.hint}>PACKET LOSS · {Math.round(mesh.dev.packetLoss * 100)}%</Text>
        <View style={styles.chipRow}>
          {LOSSES.map((loss) => (
            <Pressable
              key={loss}
              onPress={() => patch({ packetLoss: loss })}
              style={[styles.chip, mesh.dev.packetLoss === loss && styles.chipOn]}
            >
              <Text
                style={[styles.chipText, mesh.dev.packetLoss === loss && styles.chipTextOn]}
              >
                {Math.round(loss * 100)}%
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.hint}>CUT A LINK · forces multi-hop routing</Text>
        <View style={styles.chipRow}>
          {/* Only direct neighbours. A node two hops away is reached through a
              relay and has no link of its own to cut — severing the relay is
              what takes it out, and offering a button that does nothing would
              teach the wrong thing about what a hop is. */}
          {directPeers.length === 0 && (
            <Text style={[styles.chipText, { color: theme.faint }]}>no direct links to cut yet</Text>
          )}
          {directPeers.map((peer) => {
            const peerId = (peer.nodeId >>> 0).toString(16).padStart(8, '0');
            const cut = mesh.dev.cutLinks.includes(peerId);
            return (
              <Pressable
                key={peer.nodeId}
                onPress={() => toggleLink(peerId)}
                style={[styles.chip, cut && styles.chipCut]}
              >
                <Text style={[styles.chipText, cut && { color: theme.danger }]}>
                  {peer.name} {cut ? '· severed' : '· up'}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </>
  );
}
