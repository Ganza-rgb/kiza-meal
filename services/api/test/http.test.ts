import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { ScanResponse } from '@kiza/shared';
import { revokeScannerDevice } from '../src/domain/auth';
import { registerStudent } from '../src/domain/students';
import { buildApp } from '../src/http/app';
import { makeStudent, makeWorld, type TestWorld } from './helpers';

async function setup(): Promise<{ w: TestWorld; app: FastifyInstance }> {
  const w = await makeWorld();
  const app = await buildApp(w.ctx);
  return { w, app };
}

async function staffToken(app: FastifyInstance, username: string, deviceToken?: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/staff/login',
    headers: deviceToken ? { 'x-kiza-device': deviceToken } : {},
    payload: { username, password: 'correct-horse-1' },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('HTTP API: authentication and roles', () => {
  it('health reports server time and current meal', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().currentMeal, 'lunch');
  });

  it('buffet staff must sign in on an enrolled scanner phone', async () => {
    const { app, w } = await setup();
    const res = await app.inject({ method: 'POST', url: '/auth/staff/login', payload: { username: 'buffet1', password: 'correct-horse-1' } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'device_required');
    await staffToken(app, 'buffet1', w.scanners[0]!.deviceToken);
  });

  it('buffet staff cannot reach registration or payment endpoints', async () => {
    const { app, w } = await setup();
    const t = await staffToken(app, 'buffet1', w.scanners[0]!.deviceToken);
    for (const url of ['/students', '/payments', '/reports/summary', '/staff']) {
      const res = await app.inject({ method: 'GET', url, headers: auth(t) });
      assert.equal(res.statusCode, 403, url);
    }
  });

  it('registrars cannot manage staff or void claims; managers can reach reports', async () => {
    const { app } = await setup();
    const r = await staffToken(app, 'registrar');
    assert.equal((await app.inject({ method: 'GET', url: '/staff', headers: auth(r) })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `/claims/${randomUUID()}/void`, headers: auth(r), payload: { reason: 'x' } })).statusCode, 403);
    const m = await staffToken(app, 'manager');
    assert.equal((await app.inject({ method: 'GET', url: '/reports/summary', headers: auth(m) })).statusCode, 200);
  });

  it('wrong passwords lock the account after five attempts', async () => {
    const { app } = await setup();
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({ method: 'POST', url: '/auth/staff/login', payload: { username: 'registrar', password: 'nope-nope' } });
      last = res.statusCode;
    }
    assert.equal(last, 423);
  });

  it('a revoked scanner phone loses its session immediately', async () => {
    const { app, w } = await setup();
    const t = await staffToken(app, 'buffet1', w.scanners[0]!.deviceToken);
    revokeScannerDevice(w.ctx, w.manager, w.scanners[0]!.deviceId);
    const res = await app.inject({ method: 'GET', url: '/scanner/status', headers: auth(t) });
    assert.equal(res.statusCode, 401);
  });

  it('rejects invalid input with a validation error', async () => {
    const { app } = await setup();
    const t = await staffToken(app, 'registrar');
    const res = await app.inject({ method: 'POST', url: '/students', headers: auth(t), payload: { fullName: '' } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'validation_failed');
  });

  it('prevents duplicate student registration', async () => {
    const { app } = await setup();
    const t = await staffToken(app, 'registrar');
    const body = { studentNumber: 'UR-2024-001', fullName: 'A B', institution: 'UR', phone: '0788123456' };
    assert.equal((await app.inject({ method: 'POST', url: '/students', headers: auth(t), payload: body })).statusCode, 201);
    const again = await app.inject({ method: 'POST', url: '/students', headers: auth(t), payload: { ...body, studentNumber: 'ur-2024-001', phone: null } });
    assert.equal(again.json().error.code, 'duplicate_student_number');
    const samePhone = await app.inject({ method: 'POST', url: '/students', headers: auth(t), payload: { ...body, studentNumber: 'UR-2', phone: '+250788123456' } });
    assert.equal(samePhone.json().error.code, 'duplicate_phone');
  });
});

describe('HTTP API: student flow', () => {
  it('activation → device registration → summary; students cannot scan', async () => {
    const { app, w } = await setup();
    const reg = registerStudent(w.ctx, w.registrar, { studentNumber: 'RP-77', fullName: 'Test Student', institution: 'RP' });
    const act = await app.inject({
      method: 'POST',
      url: '/auth/student/activate',
      payload: { studentNumber: 'rp-77', activationCode: reg.activationCode.toLowerCase(), password: 'student-pass-1' },
    });
    assert.equal(act.statusCode, 200, act.body);
    const token = act.json().token;
    const bad = await app.inject({ method: 'POST', url: '/student/device', headers: auth(token), payload: { publicKey: 'short' } });
    assert.equal(bad.statusCode, 400);
    const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!;
    const dev = await app.inject({ method: 'POST', url: '/student/device', headers: auth(token), payload: { publicKey } });
    assert.equal(dev.statusCode, 200, dev.body);
    assert.match(dev.json().deviceId, /^[A-Za-z0-9_-]{22}$/);
    const sum = await app.inject({ method: 'GET', url: '/student/summary', headers: auth(token) });
    assert.equal(sum.statusCode, 200);
    assert.equal(sum.json().student.studentNumber, 'RP-77');
    const scan = await app.inject({ method: 'POST', url: '/scan', headers: auth(token), payload: { idempotencyKey: randomUUID(), qr: 'x' } });
    assert.equal(scan.statusCode, 403);
    // The activation code is single-use.
    const reuse = await app.inject({
      method: 'POST',
      url: '/auth/student/activate',
      payload: { studentNumber: 'RP-77', activationCode: reg.activationCode, password: 'student-pass-2' },
    });
    assert.equal(reuse.statusCode, 401);
  });
});

describe('HTTP API: scanning', () => {
  it('three buffets scanning the same student at the same moment → exactly one meal', async () => {
    const { app, w } = await setup();
    const s = makeStudent(w);
    const tokens = await Promise.all(w.scanners.map((sc, i) => staffToken(app, `buffet${i + 1}`, sc.deviceToken)));
    const results = await Promise.all(
      tokens.map((t) =>
        app.inject({ method: 'POST', url: '/scan', headers: auth(t), payload: { idempotencyKey: randomUUID(), qr: s.qr() } }),
      ),
    );
    const bodies = results.map((r) => r.json() as ScanResponse);
    assert.equal(bodies.filter((b) => b.outcome === 'accepted').length, 1);
    assert.equal(bodies.filter((b) => b.outcome === 'rejected' && b.code === 'duplicate_claim').length, 2);
  });

  it('a scanner can look up the outcome of a request whose response was lost', async () => {
    const { app, w } = await setup();
    const s = makeStudent(w);
    const t = await staffToken(app, 'buffet2', w.scanners[1]!.deviceToken);
    const key = randomUUID();
    const missing = await app.inject({ method: 'GET', url: `/scan/${key}`, headers: auth(t) });
    assert.equal(missing.statusCode, 404); // never arrived → safe to send again
    await app.inject({ method: 'POST', url: '/scan', headers: auth(t), payload: { idempotencyKey: key, qr: s.qr() } });
    const found = await app.inject({ method: 'GET', url: `/scan/${key}`, headers: auth(t) });
    assert.equal(found.json().outcome, 'accepted');
    assert.equal(found.json().replayed, true);
  });

  it('buffet staff see a student photo only right after scanning that student', async () => {
    const { app, w } = await setup();
    const s = makeStudent(w);
    const t = await staffToken(app, 'buffet1', w.scanners[0]!.deviceToken);
    const before = await app.inject({ method: 'GET', url: `/students/${s.id}/photo`, headers: auth(t) });
    assert.equal(before.statusCode, 403);
    await app.inject({ method: 'POST', url: '/scan', headers: auth(t), payload: { idempotencyKey: randomUUID(), qr: s.qr() } });
    const after = await app.inject({ method: 'GET', url: `/students/${s.id}/photo`, headers: auth(t) });
    assert.equal(after.statusCode, 200);
    assert.equal(after.headers['content-type'], 'image/png');
  });
});
