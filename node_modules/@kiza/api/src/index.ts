import { networkInterfaces } from 'node:os';
import { createBackup, scheduleBackups } from './backup';
import { loadConfig } from './config';
import type { Ctx } from './context';
import { migrate, one, openDatabase } from './db/db';
import { buildApp } from './http/app';
import { systemClock } from './time';

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a): a is NonNullable<typeof a> => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const ran = migrate(db);
  const ctx: Ctx = { db, config, clock: systemClock };

  const buffets = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM buffets')!.n;
  if (buffets === 0) {
    console.warn('\n⚠  No buffets or manager yet. Run:  npm run api:setup -- --manager-username <name> --manager-name "<Full Name>"\n');
  }

  const app = await buildApp(ctx, { logger: true });
  await app.listen({ host: config.host, port: config.port });

  const log = (m: string) => app.log.info(m);
  if (ran.length) log(`Applied migrations: ${ran.join(', ')}`);
  try {
    log(`Startup backup: ${createBackup(db, config)}`);
  } catch (err) {
    app.log.error(`Startup backup failed: ${(err as Error).message}`);
  }
  scheduleBackups(db, config, log);

  console.log('\nKiza API is running. Phones on the same Wi-Fi can use:');
  for (const ip of lanAddresses()) console.log(`   http://${ip}:${config.port}`);
  if (config.devTools) console.log(`   Dev test QR page: http://${lanAddresses()[0] ?? 'localhost'}:${config.port}/dev/qr`);
  console.log('');

  const shutdown = async (signal: string) => {
    log(`${signal} received, shutting down`);
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
