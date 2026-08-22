/**
 * Delay-tolerant delivery.
 *
 * When a RESULT is ready but the node that asked for it has gone offline, the
 * packet is persisted rather than dropped. The next HELLO from that node — or
 * any route change that makes it reachable again — triggers a flush. This is
 * what lets a phone walk out of range mid-query, come back, and still get its
 * answer.
 */

import { db } from '../search/db';
import { decodePacket, encodePacket, type Packet } from './packet';
import type { Router } from './router';

const TTL_MS = 5 * 60 * 1000;

export class StoreForward {
  private timer: number | null = null;

  constructor(
    private router: Router,
    private onChange?: (queued: number) => void,
  ) {}

  async enqueue(pkt: Packet, dstId: number): Promise<void> {
    const bytes = encodePacket(pkt);
    await db().outbox.add({
      dstId,
      bytes: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
      queuedAt: Date.now(),
      expiresAt: Date.now() + TTL_MS,
    });
    this.notify();
  }

  /** Try to deliver everything queued for `dstId`. Returns how many went out. */
  async flush(dstId?: number): Promise<number> {
    await this.expire();
    const rows =
      dstId === undefined
        ? await db().outbox.toArray()
        : await db().outbox.where('dstId').equals(dstId).toArray();

    let delivered = 0;
    for (const row of rows) {
      const pkt = decodePacket(new Uint8Array(row.bytes));
      if (!pkt) {
        await db().outbox.delete(row.id!);
        continue;
      }
      if (this.router.deliverQueued(pkt)) {
        await db().outbox.delete(row.id!);
        delivered++;
      }
    }
    if (delivered) this.notify();
    return delivered;
  }

  private async expire(): Promise<void> {
    const stale = await db().outbox.where('expiresAt').below(Date.now()).primaryKeys();
    if (stale.length) {
      await db().outbox.bulkDelete(stale);
      this.notify();
    }
  }

  async pendingCount(): Promise<number> {
    return db().outbox.count();
  }

  /** Periodic retry, so delivery does not depend solely on hearing a HELLO. */
  start(intervalMs = 5000) {
    this.stop();
    this.timer = setInterval(() => void this.flush(), intervalMs) as unknown as number;
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private notify() {
    if (!this.onChange) return;
    void this.pendingCount().then(this.onChange);
  }
}
