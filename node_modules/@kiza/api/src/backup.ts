import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from './config';
import type { Db } from './db/db';

const PREFIX = 'kiza-';

/**
 * Consistent online snapshot with VACUUM INTO (safe while the server is running, unlike copying
 * kiza.db by hand). Photos are mirrored next to the snapshots.
 */
export function createBackup(db: Db, config: Config, now: Date = new Date()): string {
  mkdirSync(config.backupDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const target = path.join(config.backupDir, `${PREFIX}${stamp}.db`);
  if (existsSync(target)) rmSync(target);
  db.prepare('VACUUM INTO ?').run(target);

  const check = verifyBackup(target);
  if (!check.ok) throw new Error(`Backup integrity check failed: ${check.message}`);

  if (existsSync(config.photosDir)) {
    cpSync(config.photosDir, path.join(config.backupDir, 'photos'), { recursive: true, force: true });
  }
  pruneBackups(config);
  return target;
}

export function listBackups(config: Config): string[] {
  if (!existsSync(config.backupDir)) return [];
  return readdirSync(config.backupDir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith('.db'))
    .sort()
    .map((f) => path.join(config.backupDir, f));
}

function pruneBackups(config: Config): void {
  const files = listBackups(config);
  for (const f of files.slice(0, Math.max(0, files.length - config.backupKeep))) rmSync(f);
}

export function verifyBackup(file: string): { ok: boolean; message: string; counts?: Record<string, number> } {
  if (!existsSync(file) || statSync(file).size === 0) return { ok: false, message: 'file missing or empty' };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const result = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (result.integrity_check !== 'ok') return { ok: false, message: result.integrity_check };
    const counts: Record<string, number> = {};
    for (const t of ['students', 'packages', 'meal_credits', 'claims', 'payments', 'audit_log']) {
      counts[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    }
    return { ok: true, message: 'ok', counts };
  } finally {
    db.close();
  }
}

export function scheduleBackups(db: Db, config: Config, log: (msg: string) => void): NodeJS.Timeout | null {
  if (config.backupIntervalHours <= 0) return null;
  const timer = setInterval(() => {
    try {
      log(`Backup written: ${createBackup(db, config)}`);
    } catch (err) {
      log(`BACKUP FAILED: ${(err as Error).message}`);
    }
  }, config.backupIntervalHours * 3600_000);
  timer.unref();
  return timer;
}
