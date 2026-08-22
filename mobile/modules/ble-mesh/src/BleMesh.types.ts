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
