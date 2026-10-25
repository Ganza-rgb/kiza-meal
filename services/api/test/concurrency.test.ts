import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ScanResponse } from '@kiza/shared';
import { countClaims, makeStudent, makeWorld, MON_LUNCH } from './helpers';

const workerFile = fileURLToPath(new URL('./fixtures/scan-worker.ts', import.meta.url));

describe('concurrency across separate database connections', () => {
  it('three scanners on three connections, same student, same instant → one accepted claim', async () => {
    for (let round = 0; round < 5; round++) {
      const w = await makeWorld({ file: true });
      const s = makeStudent(w);
      const gate = new SharedArrayBuffer(8);
      const flag = new Int32Array(gate);
      const qr = s.qr();

      const workers = w.scanners.map(
        (sc, i) =>
          new Worker(workerFile, {
            execArgv: ['--import', 'tsx'],
            workerData: {
              dbPath: w.ctx.config.dbPath,
              config: w.ctx.config,
              nowMs: MON_LUNCH.getTime(),
              scanner: { deviceId: sc.deviceId, buffet: sc.buffet, staffId: w.buffetStaff[i]!.id },
              key: randomUUID(),
              qr,
              gate,
            },
          }),
      );
      const results = workers.map(
        (wk) =>
          new Promise<{ ok: boolean; result?: ScanResponse; error?: string }>((resolve, reject) => {
            wk.once('message', resolve);
            wk.once('error', reject);
          }),
      );
      while (Atomics.load(flag, 1) < workers.length) await new Promise((r) => setTimeout(r, 5));
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);

      const out = await Promise.all(results);
      for (const o of out) assert.ok(o.ok, o.error ?? 'worker failed');
      const outcomes = out.map((o) => (o.result!.outcome === 'accepted' ? 'accepted' : o.result!.code));
      assert.equal(outcomes.filter((x) => x === 'accepted').length, 1, `round ${round}: ${outcomes.join(',')}`);
      assert.equal(outcomes.filter((x) => x === 'duplicate_claim').length, 2);
      assert.equal(countClaims(w, s.id), 1);
      w.ctx.db.close();
    }
  });
});
