/**
 * A `node:sqlite` stand-in for `expo-sqlite`, so the real `LocalCatalog` can be
 * exercised off-device.
 *
 * Only the surface `LocalCatalog` and `schema.ts` actually use is implemented,
 * and it is implemented against real SQLite — the point is to run the real SQL,
 * the real DDL and the real migration, none of which `MemoryCatalog` does.
 */
import { DatabaseSync } from 'node:sqlite';

type Params = unknown[];

function flatten(params: Params): unknown[] {
    if (params.length === 1 && Array.isArray(params[0])) return params[0] as unknown[];
    return params;
}

export class SQLiteDatabase {
    private db = new DatabaseSync(':memory:');

    async execAsync(sql: string): Promise<void> {
        this.db.exec(sql);
    }

    async runAsync(sql: string, ...params: Params) {
        const r = this.db.prepare(sql).run(...(flatten(params) as never[]));
        return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    }

    async getAllAsync<T>(sql: string, ...params: Params): Promise<T[]> {
        return this.db.prepare(sql).all(...(flatten(params) as never[])) as T[];
    }

    async getFirstAsync<T>(sql: string, ...params: Params): Promise<T | null> {
        const row = this.db.prepare(sql).get(...(flatten(params) as never[]));
        return (row ?? null) as T | null;
    }

    /** Faithful to expo-sqlite, unconditional ROLLBACK and all. */
    async withTransactionAsync(task: () => Promise<void>): Promise<void> {
        try {
            this.db.exec('BEGIN');
            await task();
            this.db.exec('COMMIT');
        } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }

    async closeAsync(): Promise<void> {
        this.db.close();
    }
}

export async function openDatabaseAsync(_name: string): Promise<SQLiteDatabase> {
    return new SQLiteDatabase();
}
