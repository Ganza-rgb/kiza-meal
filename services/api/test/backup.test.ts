import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createBackup, listBackups, verifyBackup } from '../src/backup';
import { makeStudent, makeWorld, scanAt } from './helpers';

describe('backups', () => {
  it('creates a consistent snapshot that can be opened and contains the claims', async () => {
    const w = await makeWorld({ file: true });
    const s = makeStudent(w);
    scanAt(w, 0, s.qr());
    const file = createBackup(w.ctx.db, w.ctx.config, new Date('2026-11-02T10:05:00Z'));
    const check = verifyBackup(file);
    assert.ok(check.ok, check.message);
    assert.equal(check.counts!.claims, 1);
    assert.equal(listBackups(w.ctx.config).length, 1);

    // Restoration test: the snapshot is a complete, independent database.
    const restored = new DatabaseSync(file, { readOnly: true });
    const n = restored.prepare(`SELECT COUNT(*) AS n FROM claims WHERE student_id = ?`).get(s.id) as { n: number };
    assert.equal(n.n, 1);
    restored.close();
  });

  it('keeps only the configured number of snapshots', async () => {
    const w = await makeWorld({ file: true });
    for (let i = 0; i < 7; i++) createBackup(w.ctx.db, w.ctx.config, new Date(Date.UTC(2026, 10, 2, 10, i)));
    assert.equal(listBackups(w.ctx.config).length, w.ctx.config.backupKeep);
  });
});
