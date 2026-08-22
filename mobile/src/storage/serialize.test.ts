import { describe, expect, it } from 'vitest';

import { serializer } from './serialize';

/**
 * A faithful model of `SQLiteDatabase.withTransactionAsync`.
 *
 * Copied from the shape of the real implementation, which is a bare
 * `BEGIN` / task / `COMMIT` with a `ROLLBACK` in the catch. The two behaviours
 * that matter are both reproduced: a second BEGIN throws while one is open, and
 * the resulting ROLLBACK discards whatever the *first* transaction had already
 * written.
 */
class FakeDb {
    committed: string[] = [];
    private open: string[] | null = null;

    async withTransactionAsync(task: () => Promise<void>): Promise<void> {
        try {
            if (this.open) throw new Error('cannot start a transaction within a transaction');
            this.open = [];
            await task();
            this.committed.push(...this.open);
            this.open = null;
        } catch (e) {
            // Exactly the real bug: the rollback is unconditional, so a caller
            // that never opened a transaction destroys the one that did.
            this.open = null;
            throw e;
        }
    }

    async write(value: string): Promise<void> {
        await Promise.resolve();
        this.open?.push(value);
    }
}

describe('serialized transactions', () => {
    it('reproduces the corruption when overlapping writes are not serialized', async () => {
        const db = new FakeDb();
        const results = await Promise.allSettled([
            db.withTransactionAsync(async () => {
                await db.write('a1');
                await db.write('a2');
            }),
            db.withTransactionAsync(async () => {
                await db.write('b1');
            }),
        ]);

        expect(results.some((r) => r.status === 'rejected')).toBe(true);
        // Neither transaction's work survived, which is the failure this guards.
        expect(db.committed).toEqual([]);
    });

    it('lets overlapping writes through one at a time, losing nothing', async () => {
        const db = new FakeDb();
        const transact = serializer();

        await Promise.all([
            transact(() =>
                db.withTransactionAsync(async () => {
                    await db.write('a1');
                    await db.write('a2');
                }),
            ),
            transact(() => db.withTransactionAsync(() => db.write('b1'))),
            transact(() => db.withTransactionAsync(() => db.write('c1'))),
        ]);

        expect(db.committed).toEqual(['a1', 'a2', 'b1', 'c1']);
    });

    /** One caller's failure is its own; the queue is for ordering. */
    it('keeps running after a job rejects', async () => {
        const db = new FakeDb();
        const transact = serializer();

        const failed = transact(async () => {
            throw new Error('disk full');
        });

        await expect(failed).rejects.toThrow('disk full');
        await transact(() => db.withTransactionAsync(() => db.write('after')));
        expect(db.committed).toEqual(['after']);
    });

    it('preserves submission order', async () => {
        const transact = serializer();
        const order: number[] = [];
        await Promise.all(
            [0, 1, 2, 3, 4].map((i) =>
                transact(async () => {
                    // Later jobs finish their own work faster, so anything other
                    // than a real queue would let them overtake.
                    await new Promise((r) => setTimeout(r, 5 - i));
                    order.push(i);
                }),
            ),
        );
        expect(order).toEqual([0, 1, 2, 3, 4]);
    });
});
