// npm run api:backup              -> write a snapshot now
// npm run api:backup -- --verify  -> check every snapshot's integrity
import { createBackup, listBackups, verifyBackup } from '../backup';
import { flag, openCtx } from './common';

const ctx = openCtx();
if (flag('verify')) {
  const files = listBackups(ctx.config);
  if (files.length === 0) console.log('No backups found in', ctx.config.backupDir);
  for (const f of files) {
    const r = verifyBackup(f);
    console.log(`${r.ok ? '✓' : '✗'} ${f}  ${r.ok ? JSON.stringify(r.counts) : r.message}`);
  }
} else {
  console.log('✓ Backup written:', createBackup(ctx.db, ctx.config));
}
ctx.db.close();
