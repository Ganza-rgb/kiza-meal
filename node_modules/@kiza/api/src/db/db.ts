import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { migrations } from './migrations';

export type Db = DatabaseSync;
export type Params = Record<string, SQLInputValue>;
export type Row = Record<string, SQLInputValue>;

export function openDatabase(dbPath: string): Db {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  // WAL lets readers proceed while a claim is being written; synchronous=FULL keeps a confirmed
  // claim durable across a power cut, which matters more here than write throughput.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  return db;
}

export function migrate(db: Db, now: Date = new Date()): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  const ran: number[] = [];
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        now.toISOString(),
      );
    });
    ran.push(m.version);
  }
  return ran;
}

/**
 * Runs fn inside BEGIN IMMEDIATE: the write lock is taken up front, so concurrent claim attempts
 * (from other connections or processes) queue instead of racing. Nested calls reuse the outer
 * transaction.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

export function one<T>(db: Db, sql: string, params: Params | SQLInputValue[] = []): T | undefined {
  const stmt = db.prepare(sql);
  return (Array.isArray(params) ? stmt.get(...params) : stmt.get(params)) as T | undefined;
}

export function all<T>(db: Db, sql: string, params: Params | SQLInputValue[] = []): T[] {
  const stmt = db.prepare(sql);
  return (Array.isArray(params) ? stmt.all(...params) : stmt.all(params)) as T[];
}

export function run(db: Db, sql: string, params: Params | SQLInputValue[] = []) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.run(...params) : stmt.run(params);
}

export function isUniqueViolation(err: unknown, indexOrColumn?: string): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  if (!msg.includes('UNIQUE constraint failed')) return false;
  return indexOrColumn ? msg.includes(indexOrColumn) : true;
}

export const bool = (v: boolean): number => (v ? 1 : 0);
