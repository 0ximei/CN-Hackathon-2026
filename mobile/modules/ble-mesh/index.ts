import { NativeModule, requireNativeModule } from 'expo';

import type {
  BleCapabilities,
  BleMeshEvents,
  BlePeer,
  StartResult,
} from './src/BleMesh.types';

declare class BleMeshNativeModule extends NativeModule<BleMeshEvents> {
  capabilities(): BleCapabilities;
  /**
   * Idempotent. Resolves with `ok: false` and a human-readable reason.
   *
   * `nodeId` must be the *signed* 32-bit form: the native side types it as
   * Kotlin's `Int`, which cannot hold the unsigned values `hash32` produces.
   */
  start(nodeId: number): Promise<StartResult>;
  stop(): Promise<void>;
  /**
   * Runs the radio under a foreground service, so it survives the app closing.
   *
   * A permanent notification is the price and the disclosure: Android will not
   * let a process keep a radio open once the user leaves without one, and the
   * user should be able to see — and stop — a mesh running behind their back.
   */
  setBackground(on: boolean): Promise<void>;
  /** Base64 payload. Resolves false when no link to that peer is open. */
  send(peerId: string, data: string): Promise<boolean>;
  /** Base64 payload. Resolves with the number of links it went out on. */
  broadcast(data: string, except: string | null): Promise<number>;
  peers(): BlePeer[];
}

export default requireNativeModule<BleMeshNativeModule>('BleMesh');
export type { BleCapabilities, BleMeshEvents, BlePeer, StartResult };
