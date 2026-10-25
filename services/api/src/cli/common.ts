import { randomInt } from 'node:crypto';
import { loadConfig } from '../config';
import { SYSTEM, newId, type Ctx } from '../context';
import { migrate, one, openDatabase, run, transaction } from '../db/db';
import { audit } from '../domain/audit';
import { systemClock } from '../time';

export function openCtx(): Ctx {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  migrate(db);
  return { db, config, clock: systemClock };
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}

export const flag = (name: string) => process.argv.includes(`--${name}`);

/** Readable random password, e.g. "Kiza-7hq3-Mx9p-2wtr". Printed once; the user must change it at first login. */
export function generatePassword(): string {
  const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const chunk = () => Array.from({ length: 4 }, () => a[randomInt(a.length)]).join('');
  return `Kiza-${chunk()}-${chunk()}-${chunk()}`;
}

/** The three buffets. Names can be changed later directly in the database or a future settings screen. */
export function ensureBuffets(ctx: Ctx): void {
  transaction(ctx.db, () => {
    for (const n of [1, 2, 3]) {
      const code = `B${n}`;
      if (one(ctx.db, 'SELECT 1 AS x FROM buffets WHERE code = ?', [code])) continue;
      const id = newId();
      run(ctx.db, 'INSERT INTO buffets (id, code, name, active, created_at) VALUES (?, ?, ?, 1, ?)', [
        id,
        code,
        `Buffet ${n}`,
        ctx.clock().toISOString(),
      ]);
      audit(ctx, SYSTEM, 'buffet.create', 'buffet', id, { code });
    }
  });
}
