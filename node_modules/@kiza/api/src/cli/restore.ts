// Restore a snapshot. STOP THE SERVER FIRST.
//   npm run restore -w @kiza/api -- --file backups/kiza-2026-10-25_12-00-00.db --yes
// The current database is kept as kiza.db.pre-restore-<time> so a restore can itself be undone.

import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { verifyBackup } from '../backup';
import { loadConfig } from '../config';
import { arg, flag } from './common';

const config = loadConfig();
const file = arg('file');
if (!file) {
  console.error('Usage: npm run restore -w @kiza/api -- --file <backup.db> --yes');
  process.exit(1);
}
const source = path.resolve(file);
const check = verifyBackup(source);
if (!check.ok) {
  console.error(`✗ ${source} failed the integrity check: ${check.message}`);
  process.exit(1);
}
console.log(`Backup OK: ${JSON.stringify(check.counts)}`);
if (!flag('yes')) {
  console.log('Re-run with --yes to replace the live database (make sure the Kiza server is stopped).');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
if (existsSync(config.dbPath)) {
  renameSync(config.dbPath, `${config.dbPath}.pre-restore-${stamp}`);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(config.dbPath + suffix)) rmSync(config.dbPath + suffix);
  }
}
copyFileSync(source, config.dbPath);
console.log(`✓ Restored ${source} -> ${config.dbPath}`);
console.log('  Photos: copy the backup "photos" folder into the data folder if photos were lost too.');
