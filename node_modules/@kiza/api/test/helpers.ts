import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildQrPayload, qrSignedMessage, type ScanResponse } from '@kiza/shared';
import type { Config } from '../src/config';
import type { Actor, Ctx } from '../src/context';
import { migrate, openDatabase, run } from '../src/db/db';
import { createScannerDevice, createStaff, enrollScannerDevice, listBuffets, registerStudentDevice } from '../src/domain/auth';
import { processScan } from '../src/domain/claims';
import { activatePackage, createPackage, createPackageType, type PackageTypeInput } from '../src/domain/packages';
import { createPayment, transitionPayment } from '../src/domain/payments';
import { registerStudent, saveStudentPhoto, updateStudent } from '../src/domain/students';
import { ensureBuffets } from '../src/cli/common';
import { placeholderPng } from '../src/cli/placeholder';

process.env.KIZA_FAST_HASH = '1';

/** 2026-11-02 is a Monday. 10:00Z = 12:00 in Kigali → lunch. */
export const MON_LUNCH = new Date('2026-11-02T10:00:00Z');
export const MON_DINNER = new Date('2026-11-02T17:00:00Z'); // 19:00 Kigali
export const TUE_LUNCH = new Date('2026-11-03T10:00:00Z');
export const MON_AFTERNOON_GAP = new Date('2026-11-02T14:00:00Z'); // 16:00 Kigali, between meals

export function testConfig(dataDir: string): Config {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    dbPath: path.join(dataDir, 'kiza.db'),
    photosDir: path.join(dataDir, 'photos'),
    backupDir: path.join(dataDir, 'backups'),
    backupIntervalHours: 0,
    backupKeep: 5,
    qrMaxAgeSeconds: 90,
    staffSessionHours: 14,
    studentSessionDays: 60,
    devTools: false,
    production: false,
  };
}

export interface TestWorld {
  ctx: Ctx;
  setNow(d: Date): void;
  manager: Actor & { type: 'staff' };
  registrar: Actor & { type: 'staff' };
  buffetStaff: (Actor & { type: 'staff' })[];
  scanners: { deviceId: string; deviceToken: string; buffet: { id: string; code: string; name: string } }[];
  calendar5: string;
  flexible3: string;
  dinnerOnly: string;
}

export async function makeWorld(opts: { file?: boolean } = {}): Promise<TestWorld> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'kiza-test-'));
  const config = testConfig(dataDir);
  const db = openDatabase(opts.file ? config.dbPath : ':memory:');
  let now = MON_LUNCH;
  const ctx: Ctx = { db, config, clock: () => now };
  migrate(db, now);
  ensureBuffets(ctx);
  const sys: Actor = { type: 'system', id: null };

  const mk = async (username: string, role: 'manager' | 'registrar' | 'buffet_staff') => {
    const s = await createStaff(ctx, sys, { username, fullName: `Test ${username}`, role, password: 'correct-horse-1' });
    run(db, 'UPDATE staff SET must_change_password = 0 WHERE id = ?', [s.id]);
    return { type: 'staff' as const, id: s.id, role, name: s.fullName };
  };
  const manager = await mk('manager', 'manager');
  const registrar = await mk('registrar', 'registrar');
  const buffetStaff = [await mk('buffet1', 'buffet_staff'), await mk('buffet2', 'buffet_staff'), await mk('buffet3', 'buffet_staff')];

  const scanners = listBuffets(ctx).map((b) => {
    const created = createScannerDevice(ctx, manager, b.id, `${b.code} phone`);
    const enrolled = enrollScannerDevice(ctx, created.enrollmentCode);
    return { deviceId: enrolled.device.id, deviceToken: enrolled.deviceToken, buffet: enrolled.device.buffet };
  });

  const pt = (input: PackageTypeInput) => createPackageType(ctx, manager, input).id;
  return {
    ctx,
    setNow: (d) => {
      now = d;
    },
    manager,
    registrar,
    buffetStaff,
    scanners,
    calendar5: pt({ name: 'Test 5 days', mode: 'calendar', mealDays: 5, priceRwf: 5000, includesLunch: true, includesDinner: true }),
    flexible3: pt({
      name: 'Test flex 3',
      mode: 'flexible',
      mealDays: 3,
      validityDays: 10,
      priceRwf: 3000,
      includesLunch: true,
      includesDinner: true,
    }),
    dinnerOnly: pt({ name: 'Dinner only', mode: 'calendar', mealDays: 5, priceRwf: 2000, includesLunch: false, includesDinner: true }),
  };
}

export interface TestStudent {
  id: string;
  deviceId: string;
  secretKey: string;
  publicKey: string;
  qr(at?: Date): string;
}

export function makeStudent(
  w: TestWorld,
  opts: { number?: string; confirm?: boolean; packageTypeId?: string | null; verifyPayment?: boolean; activate?: boolean } = {},
): TestStudent & { packageId: string | null } {
  const { ctx, registrar } = w;
  const number = opts.number ?? `UR-${Math.floor(Math.random() * 1e9)}`;
  const r = registerStudent(ctx, registrar, { studentNumber: number, fullName: `Student ${number}`, institution: 'UR' });
  if (opts.confirm !== false) {
    saveStudentPhoto(ctx, registrar, r.student.id, placeholderPng(1).toString('base64'));
    updateStudent(ctx, registrar, r.student.id, { status: 'active' });
  }
  let packageId: string | null = null;
  const typeId = opts.packageTypeId === undefined ? w.calendar5 : opts.packageTypeId;
  if (typeId) {
    const p = createPackage(ctx, registrar, r.student.id, typeId);
    packageId = p.id;
    const pay = createPayment(ctx, registrar, {
      studentId: r.student.id,
      packageId: p.id,
      amountRwf: p.priceRwf,
      method: 'cash',
    });
    if (opts.verifyPayment !== false) transitionPayment(ctx, registrar, pay.id, 'verify');
    if (opts.activate !== false && opts.verifyPayment !== false) activatePackage(ctx, registrar, p.id);
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }).x!;
  const sec = privateKey.export({ format: 'jwk' }).d!;
  const dev = registerStudentDevice(ctx, r.student.id, pub, 'test');
  return {
    id: r.student.id,
    packageId,
    deviceId: dev.deviceId,
    secretKey: sec,
    publicKey: pub,
    qr: (at = ctx.clock()) => signQr(dev.deviceId, pub, sec, Math.floor(at.getTime() / 1000)),
  };
}

export function signQr(deviceId: string, pub: string, sec: string, issuedAt: number): string {
  const key = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: sec, x: pub }, format: 'jwk' });
  const sig = sign(null, Buffer.from(qrSignedMessage(deviceId, issuedAt)), key).toString('base64url');
  return buildQrPayload(deviceId, issuedAt, sig);
}

export function scanAt(w: TestWorld, buffetIndex: number, qr: string, key: string = randomUUID()): ScanResponse {
  const s = w.scanners[buffetIndex]!;
  return processScan(w.ctx, { deviceId: s.deviceId, buffet: s.buffet, staffId: w.buffetStaff[buffetIndex]!.id }, key, qr);
}

export function countClaims(w: TestWorld, studentId: string): number {
  return (w.ctx.db.prepare(`SELECT COUNT(*) AS n FROM claims WHERE student_id = ? AND status = 'confirmed'`).get(studentId) as { n: number }).n;
}
