// Runs in a separate worker thread with its OWN SQLite connection to the same database file,
// to prove that claims are serialised by the database itself, not by Node's single thread.
import { parentPort, workerData } from 'node:worker_threads';
import type { Ctx } from '../../src/context';
import { openDatabase } from '../../src/db/db';
import { processScan } from '../../src/domain/claims';

const { dbPath, config, nowMs, scanner, key, qr, gate } = workerData as {
  dbPath: string;
  config: Ctx['config'];
  nowMs: number;
  scanner: { deviceId: string; buffet: { id: string; code: string; name: string }; staffId: string };
  key: string;
  qr: string;
  gate: SharedArrayBuffer;
};

const db = openDatabase(dbPath);
const ctx: Ctx = { db, config, clock: () => new Date(nowMs) };
const flag = new Int32Array(gate);
Atomics.add(flag, 1, 1); // ready
Atomics.wait(flag, 0, 0); // wait for the start signal
try {
  const result = processScan(ctx, scanner, key, qr);
  parentPort!.postMessage({ ok: true, result });
} catch (err) {
  parentPort!.postMessage({ ok: false, error: (err as Error).message });
} finally {
  db.close();
}
