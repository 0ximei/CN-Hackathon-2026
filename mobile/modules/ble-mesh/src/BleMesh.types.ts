/** A live, identified link to one directly-reachable node. */
export interface BlePeer {
  /** Node id as 8 lowercase hex digits. This is the transport's `peerId`. */
  peerId: string;
  /** Signed 32-bit; `peerId` is the same value as unsigned hex, and is the key. */
  nodeId: number;
  /** Which end dialled: `central` means we did. */
  role: 'central' | 'peripheral';
  /** Negotiated ATT MTU for this link, in bytes. */
  mtu: number;
  /** Signal strength at discovery, dBm. 0 when never scanned (inbound links). */
  rssi: number;
}

export interface BleCapabilities {
  hasAdapter: boolean;
  enabled: boolean;
  /**
   * Whether this device can act as a BLE peripheral. Almost every phone since
   * 2015 can; a handful of budget chipsets cannot, and on those the node can
   * dial out but is invisible to scanners — a leaf, never a relay.
   */
  canAdvertise: boolean;
  /**
   * Whether this handset could carry the mesh over Wi-Fi instead of BLE.
   *
   * Reported so the choice rests on the phones in the room rather than on a
   * generalisation. Only `wifiAware` matters for a *mesh*: it is the one Wi-Fi
   * mode that publishes and subscribes at the same time and holds several data
   * paths at once, which is the property BLE is providing here. `wifiDirect` is
   * near-universal and forms a group with one owner — a star, not a mesh.
   *
   * Aware support depends on the chipset and the vendor HAL, not the Android
   * version, so it has to be asked rather than assumed.
   */
  wifiDirect: boolean;
  wifiAware: boolean;
  /** Supported *and* usable right now — Aware goes away when Wi-Fi is off. */
  wifiAwareReady: boolean;
  wifiAwareDetail: string;
}

export interface StartResult {
  ok: boolean;
  error: string | null;
}

export type BleMeshEvents = {
  onFrame(event: { peerId: string; data: string }): void;
  onPeers(event: { peers: BlePeer[] }): void;
  onLog(event: { message: string }): void;
  onState(event: { state: string; detail: string }): void;
};
