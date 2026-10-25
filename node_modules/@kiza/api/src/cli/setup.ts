// Production first-time setup: creates the three buffets and the first manager account.
//   npm run api:setup -- --manager-username jean --manager-name "Jean Bosco Habimana"
// The generated password is shown ONCE and must be changed at first sign-in.

import { SYSTEM } from '../context';
import { one } from '../db/db';
import { createStaff } from '../domain/auth';
import { arg, ensureBuffets, flag, generatePassword, openCtx } from './common';

async function main() {
  const username = arg('manager-username');
  const fullName = arg('manager-name');
  const ctx = openCtx();
  ensureBuffets(ctx);
  console.log('✓ Buffets B1, B2, B3 are present.');

  const managers = one<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM staff WHERE role = 'manager' AND active = 1`)!.n;
  if (managers > 0 && !flag('add-manager')) {
    console.log(`✓ ${managers} active manager account(s) already exist. Use --add-manager to create another.`);
    return;
  }
  if (!username || !fullName) {
    console.error('Usage: npm run api:setup -- --manager-username <username> --manager-name "<Full Name>"');
    process.exit(1);
  }
  const password = generatePassword();
  const staff = await createStaff(ctx, SYSTEM, { username, fullName, role: 'manager', password });
  console.log('\n✓ Manager account created');
  console.log(`   Username:           ${staff.username}`);
  console.log(`   Temporary password: ${password}`);
  console.log('   This password is shown only once. Sign in on the Kiza app and change it immediately.\n');
  ctx.db.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
