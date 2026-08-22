/**
 * A one-at-a-time queue for database writes.
 *
 * Lives in its own module, free of `expo-sqlite`, so the property it exists to
 * guarantee can actually be tested — importing `LocalCatalog` from Node pulls
 * in the native SQLite binding and its React Native dependency chain.
 *
 * The problem it solves is specific. `SQLiteDatabase.withTransactionAsync`
 * issues a bare BEGIN and COMMIT on the shared connection and has no idea
 * whether another caller is already inside a transaction. A second BEGIN throws
 * `cannot start a transaction within a transaction`, and its catch clause then
 * issues a ROLLBACK — which discards the *first* transaction's uncommitted
 * work. Two overlapping writes do not merely race: both fail, and one of them
 * silently loses data it had already written.
 */
export interface Serializer {
    /** Runs `work` after every previously queued job has settled. */
    (work: () => Promise<void>): Promise<void>;
}

export function serializer(): Serializer {
    let tail: Promise<unknown> = Promise.resolve();

    return (work) => {
        // Both arms run `work`: a predecessor that rejected must not cancel its
        // successors, because the queue is here for ordering and not to
        // propagate one caller's failure to another's.
        const run = tail.then(work, work);
        tail = run.catch(() => undefined);
        return run;
    };
}
