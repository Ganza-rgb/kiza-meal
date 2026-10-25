import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { ScanAccepted, ScanRejected } from '@kiza/shared';
import { revokeStudentDevices, updateStudent } from '../src/domain/students';
import { activatePackage, createPackage } from '../src/domain/packages';
import { createPayment, transitionPayment } from '../src/domain/payments';
import { recordManualClaim, voidClaim } from '../src/domain/claims';
import { addClosure } from '../src/domain/settings';
import { ApiError } from '../src/errors';
import { countClaims, makeStudent, makeWorld, MON_AFTERNOON_GAP, MON_DINNER, MON_LUNCH, scanAt, signQr, TUE_LUNCH } from './helpers';

const accepted = (r: unknown) => {
  assert.equal((r as ScanAccepted).outcome, 'accepted', `expected accepted, got ${JSON.stringify(r)}`);
  return r as ScanAccepted;
};
const rejected = (r: unknown, code: ScanRejected['code']) => {
  assert.equal((r as ScanRejected).outcome, 'rejected', `expected rejection ${code}, got ${JSON.stringify(r)}`);
  assert.equal((r as ScanRejected).code, code);
  return r as ScanRejected;
};

describe('meal claims', () => {
  it('accepts a valid first lunch and records buffet, meal and date', async () => {
    const w = await makeWorld();
    const s = makeStudent(w);
    const r = accepted(scanAt(w, 0, s.qr()));
    assert.equal(r.meal, 'lunch');
    assert.equal(r.serviceDate, '2026-11-02');
    assert.equal(r.buffet.code, 'B1');
    assert.equal(r.remainingForMeal, 4);
    assert.equal(countClaims(w, s.id), 1);
  });

  it('rejects a duplicate lunch, even at another buffet, and says where the first one was', async () => {
    const w = await makeWorld();
    const s = makeStudent(w);
    accepted(scanAt(w, 0, s.qr()));
    const dup = rejected(scanAt(w, 2, s.qr()), 'duplicate_claim');
    assert.equal(dup.previousClaim?.buffetName, 'Buffet 1');
    assert.equal(countClaims(w, s.id), 1);
  });

  it('a replayed (copied) QR from an accepted scan cannot claim a second meal', async () => {
    const w = await makeWorld();
    const s = makeStudent(w);
    const qr = s.qr();
    accepted(scanAt(w, 0, qr));
    rejected(scanAt(w, 1, qr), 'duplicate_claim');
  });

  it('allows dinner after lunch on the same day and lunch the next day', async () => {
    const w = await makeWorld();
    const s = makeStudent(w);
    accepted(scanAt(w, 0, s.qr()));
    w.setNow(MON_DINNER);
    const dinner = accepted(scanAt(w, 1, s.qr()));
    assert.equal(dinner.meal, 'dinner');
    w.setNow(TUE_LUNCH);
    const tue = accepted(scanAt(w, 2, s.qr()));
    assert.equal(tue.serviceDate, '2026-11-03');
    assert.equal(countClaims(w, s.id), 3);
  });

  it('rejects scans between meal windows', async () => {
    const w = await makeWorld();
    const s = makeStudent(w);
    w.setNow(MON_AFTERNOON_GAP);
    rejected(scanAt(w, 0, s.qr()), 'outside_service_hours');
  });

  it('rejects an expired calendar package', async () => {
    const w = await makeWorld();
    const s = makeStudent(w); // Mon 2 Nov – Fri 6 Nov
    w.setNow(new Date('2026-11-09T10:00:00Z'));
    rejected(scanAt(w, 0, s.qr()), 'package_expired');
  });

  it('a calendar day that passes unused is lost (no carry-over)', async () => {
    const w = await makeWorld();
    const s = makeStudent(w);
    w.setNow(new Date('2026-11-04T10:00:00Z')); // Wednesday; Mon & Tue unused
    const r = accepted(scanAt(w, 0, s.qr()));
    assert.equal(r.remainingForMeal, 2); // Thu, Fri
  });

  it('rejects a package whose payment has not been verified, and refuses to activate it', async () => {
    const w = await makeWorld();
    const s = makeStudent(w, { verifyPayment: false });
    rejected(scanAt(w, 0, s.qr()), 'payment_pending');
    assert.throws(() => activatePackage(w.ctx, w.registrar, s.packageId!), (e: unknown) => (e as ApiError).code === 'payment_insufficient');
  });

  it('a student-reported payment does not activate anything', async () => {
    const w = await makeWorld();
    const s = makeStudent(w, { verifyPayment: false });
    createPayment(w.ctx, { type: 'student', id: s.id }, {
      studentId: s.id,
      packageId: s.packageId,
      amountRwf: 5000,
      method: 'momo',
      reference: 'MP123456',
    });
    assert.throws(() => activatePackage(w.ctx, w.registrar, s.packageId!), (e: unknown) => (e as ApiError).code === 'payment_insufficient');
    rejected(scanAt(w, 0, s.qr()), 'payment_pending');
  });

  it('rejects when there is no package at all', async () => {
    const w = await makeWorld();
    const s = makeStudent(w, { packageTypeId: null });
    rejected(scanAt(w, 0, s.qr()), 'no_active_package');
  });

  it('rejects a package scheduled to start later', async () => {
    const w = await makeWorld();
    const s = makeStudent(w, { packageTypeId: null });
    const p = createPackage(w.ctx, w.registrar, s.id, w.calendar5, '2026-11-10');
    const pay = createPayment(w.ctx, w.registrar, { studentId: s.id, packageId: p.id, amountRwf: 5000, method: 'cash' });
    transitionPayment(w.ctx, w.registrar, pay.id, 'verify');
    activatePackage(w.ctx, w.registrar, p.id);
    rejected(scanAt(w, 0, s.qr()), 'package_not_started');
  });

  it('rejects lunch on a dinner-only package', async () => {
    const w = await makeWorld();
    const s = makeStudent(w, { packageTypeId: w.dinnerOnly });
    rejected(scanAt(w, 0, s.qr()), 'meal_not_included');
    w.setNow(MON_DINNER);
    accepted(scanAt(w, 0, s.qr()));
  });

  it('rejects unconfirmed registrations and suspended students', async () => {
    const w = await makeWorld();
    const pending = makeStudent(w, { confirm: false, packageTypeId: null });
    rejected(scanAt(w, 0, pending.qr()), 'registration_pending');
    const s = makeStudent(w);
    updateStudent(w.ctx, w.manager, s.id, { status: 'suspended', reason: 'test' });
    rejected(scanAt(w, 0, s.qr()), 'student_suspended');
  });

  it('flexible packages: any day in the validity window, until the credits run out', async () => {
    const w = await makeWorld();
    const s = makeStudent(w, { packageTypeId: w.flexible3 });
    for (const day of ['2026-11-02', '2026-11-05', '2026-11-08']) {
      w.setNow(new Date(`${day}T10:00:00Z`));
      accepted(scanAt(w, 0, s.qr()));
    }
    w.setNow(new Date('2026-11-09T10:00:00Z'));
    rejected(scanAt(w, 0, s.qr()), 'no_entitlement');
    w.setNow(new Date('2026-11-09T17:00:00Z'));
    accepted(scanAt(w, 0, s.qr())); // dinners are separate credits
    w.setNow(new Date('2026-11-12T17:00:00Z'));
    rejected(scanAt(w, 0, s.qr()), 'package_expired'); // validity was 10 days (2–11 Nov)
  });

  it('calendar renewals queue after the current package and skip closure days', async () => {
    const w = await makeWorld();
    const s = makeStudent(w); // 2–6 Nov
    addClosure(w.ctx, w.manager, '2026-11-08', 'Umuganda / test closure');
    const p = createPackage(w.ctx, w.registrar, s.id, w.calendar5);
    const pay = createPayment(w.ctx, w.registrar, { studentId: s.id, packageId: p.id, amountRwf: 5000, method: 'cash' });
    transitionPayment(w.ctx, w.registrar, pay.id, 'verify');
    const renewed = activatePackage(w.ctx, w.registrar, p.id);
    assert.equal(renewed.startDate, '2026-11-07');
    assert.equal(renewed.endDate, '2026-11-12'); // 7, 9, 10, 11, 12 (8th closed)
  });
});

describe('QR credentials', () => {
  it('rejects a tampered signature', async () => {
    const w = await makeWorld();
    const s = makeStudent(w);
    const qr = s.qr();
    const tampered = qr.slice(0, -2) + (qr.endsWith('AA') ? 'BB' : 'AA');
    rejected(scanAt(w, 0, tampered), 'invalid_qr');
  });

  it('rejects garbage and plain student numbers', async () => {
    const w = await makeWorld();
    rejected(scanAt(w, 0, 'UR-12345'), 'invalid_qr');
    rejected(scanAt(w, 0, 'https://example.com'), 'invalid_qr');
  });

  it('rejects an old screenshot (expired QR)', async () => {
    const w = await makeWorld();
    const s = makeStudent(w);
    const old = s.qr(new Date(MON_LUNCH.getTime() - 5 * 60_000));
    rejected(scanAt(w, 0, old), 'expired_qr');
  });

  it('rejects a revoked phone (lost phone / new phone registered)', async () => {
    const w = await makeWorld();
    const s = makeStudent(w);
    revokeStudentDevices(w.ctx, w.registrar, s.id, 'lost phone');
    rejected(scanAt(w, 0, s.qr()), 'revoked_credential');
  });

  it('a QR signed by a different key for a real device id is invalid', async () => {
    const w = await makeWorld();
    const victim = makeStudent(w);
    const attacker = makeStudent(w);
    const forged = signQr(victim.deviceId, attacker.publicKey, attacker.secretKey, Math.floor(MON_LUNCH.getTime() / 1000));
    rejected(scanAt(w, 0, forged), 'invalid_qr');
  });
});

describe('idempotency and lost responses', () => {
  it('retrying with the same key returns the original acceptance, not a duplicate', async () => {
    const w = await makeWorld();
    const s = makeStudent(w);
    const key = randomUUID();
    const first = accepted(scanAt(w, 0, s.qr(), key));
    // Response "lost"; the scanner retries the same request 30 s later with a fresh QR frame.
    w.setNow(new Date(MON_LUNCH.getTime() + 30_000));
    const retry = accepted(scanAt(w, 0, s.qr(), key));
    assert.equal(retry.claimId, first.claimId);
    assert.equal(retry.replayed, true);
    assert.equal(countClaims(w, s.id), 1);
  });

  it('an idempotency key cannot be reused from another scanner', async () => {
    const w = await makeWorld();
    const s = makeStudent(w);
    const key = randomUUID();
    accepted(scanAt(w, 0, s.qr(), key));
    assert.throws(() => scanAt(w, 1, s.qr(), key), (e: unknown) => (e as ApiError).code === 'conflict');
  });
});

describe('corrections', () => {
  it('a manager void restores the credit and the meal can be claimed again', async () => {
    const w = await makeWorld();
    const s = makeStudent(w);
    const r = accepted(scanAt(w, 0, s.qr()));
    voidClaim(w.ctx, w.manager, r.claimId, 'Scanned by mistake');
    assert.equal(countClaims(w, s.id), 0);
    accepted(scanAt(w, 1, s.qr()));
  });

  it('manual (paper-log) claims obey the same one-meal-per-session rule', async () => {
    const w = await makeWorld();
    const s = makeStudent(w);
    const buffet = w.scanners[0]!.buffet.id;
    const input = { studentId: s.id, serviceDate: '2026-11-02', meal: 'lunch' as const, buffetId: buffet, reference: 'PAPER-1', reason: 'outage' };
    recordManualClaim(w.ctx, w.registrar, input);
    assert.throws(() => recordManualClaim(w.ctx, w.registrar, { ...input, reference: 'PAPER-2' }));
    rejected(scanAt(w, 0, s.qr()), 'duplicate_claim');
  });
});
