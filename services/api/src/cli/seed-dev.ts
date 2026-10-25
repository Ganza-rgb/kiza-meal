// DEVELOPMENT FIXTURES ONLY. Creates clearly labelled [TEST] staff, students, packages and payments
// so every scan outcome can be tried. Refuses to run with NODE_ENV=production.
//
//   npm run api:seed:dev            (first time)
//   npm run api:seed:dev -- --reset (wipe the dev database and seed again)

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config';
import type { Actor, Ctx } from '../context';
import { migrate, one, openDatabase, run } from '../db/db';
import { createScannerDevice, createStaff, listBuffets, registerStudentDevice } from '../domain/auth';
import { activatePackage, createPackage, createPackageType } from '../domain/packages';
import { createPayment, transitionPayment } from '../domain/payments';
import { setMealWindows } from '../domain/settings';
import { registerStudent, saveStudentPhoto, updateStudent } from '../domain/students';
import type { DevTestDevice } from '../http/routes/dev';
import { systemClock } from '../time';
import { ensureBuffets, flag, generatePassword } from './common';
import { placeholderPng } from './placeholder';

function devKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }).x!;
  const sec = privateKey.export({ format: 'jwk' }).d!;
  return { publicKey: pub, secretKey: sec };
}

async function main() {
  const config = loadConfig();
  if (config.production) throw new Error('Refusing to seed test data when NODE_ENV=production');

  if (flag('reset')) {
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(config.dbPath + suffix)) rmSync(config.dbPath + suffix);
    if (existsSync(config.photosDir)) rmSync(config.photosDir, { recursive: true });
    console.log('✓ Dev database wiped');
  }
  const db = openDatabase(config.dbPath);
  migrate(db);
  const ctx: Ctx = { db, config, clock: systemClock };

  if (one(db, `SELECT 1 AS x FROM students WHERE student_number = 'TEST-0001'`)) {
    console.log('Test data already present. Use  npm run api:seed:dev -- --reset  to start over.');
    return;
  }

  ensureBuffets(ctx);
  const buffets = listBuffets(ctx);
  const sys: Actor = { type: 'system', id: null };

  // ---- Staff (random passwords, written to data/dev-credentials.txt) ----
  const creds: string[] = ['KIZA DEVELOPMENT CREDENTIALS — TEST DATA ONLY', ''];
  const mkStaff = async (username: string, fullName: string, role: 'manager' | 'registrar' | 'buffet_staff') => {
    const password = generatePassword();
    const s = await createStaff(ctx, sys, { username, fullName, role, password });
    run(db, 'UPDATE staff SET must_change_password = 0 WHERE id = ?', [s.id]); // dev convenience only
    creds.push(`${role.padEnd(13)} username: ${username.padEnd(14)} password: ${password}`);
    return { type: 'staff', id: s.id, role, name: fullName } as Actor & { type: 'staff' };
  };
  const manager = await mkStaff('dev.manager', '[TEST] Umuyobozi', 'manager');
  const registrar = await mkStaff('dev.registrar', '[TEST] Umwanditsi', 'registrar');
  for (const n of [1, 2, 3]) await mkStaff(`dev.buffet${n}`, `[TEST] Umukozi wa Buffet ${n}`, 'buffet_staff');

  // ---- Scanner phones ----
  creds.push('', 'Scanner enrolment codes (valid 24 h, one phone each):');
  for (const b of buffets) {
    const d = createScannerDevice(ctx, manager, b.id, `${b.name} — telefoni`);
    creds.push(`  ${b.code}  ${d.enrollmentCode}`);
  }

  // ---- Wide meal windows so testing works at any hour ----
  setMealWindows(ctx, manager, { lunch: { start: '00:00', end: '16:00' }, dinner: { start: '16:00', end: '23:59' } });

  // ---- Package types (TEST prices — real prices must be configured by Kiza management) ----
  const cal5 = createPackageType(ctx, manager, {
    name: '[TEST] Igifu cy\'iminsi 5',
    mode: 'calendar',
    mealDays: 5,
    priceRwf: 1000,
    includesLunch: true,
    includesDinner: true,
    notes: 'Test fixture — not a real price',
  });
  const flex10 = createPackageType(ctx, manager, {
    name: '[TEST] Amafunguro 10 (igihe cyoroshye)',
    mode: 'flexible',
    mealDays: 10,
    validityDays: 30,
    priceRwf: 2000,
    includesLunch: true,
    includesDinner: true,
    notes: 'Test fixture — not a real price',
  });
  const dinnerOnly = createPackageType(ctx, manager, {
    name: '[TEST] Ifunguro rya nimugoroba gusa — iminsi 5',
    mode: 'calendar',
    mealDays: 5,
    priceRwf: 600,
    includesLunch: false,
    includesDinner: true,
    notes: 'Test fixture: dinner only — scanning at lunch shows meal_not_included',
  });

  // ---- Students ----
  const devices: DevTestDevice[] = [];
  creds.push('', 'Test students (activate in the student app with number + code):');
  let ref = 1;
  const mkStudent = async (
    num: string,
    name: string,
    setup: (id: string) => void,
    opts: { photo?: boolean; confirm?: boolean } = { photo: true, confirm: true },
  ) => {
    const r = registerStudent(ctx, registrar, { studentNumber: num, fullName: name, institution: num.endsWith('2') ? 'RP' : 'UR' });
    if (opts.photo) saveStudentPhoto(ctx, registrar, r.student.id, placeholderPng(ref).toString('base64'));
    if (opts.confirm) updateStudent(ctx, registrar, r.student.id, { status: 'active' });
    setup(r.student.id);
    const kp = devKeyPair();
    const dev = registerStudentDevice(ctx, r.student.id, kp.publicKey, 'dev-test-page');
    devices.push({ studentNumber: num, fullName: name, deviceId: dev.deviceId, ...kp });
    creds.push(`  ${num}  code: ${r.activationCode}  — ${name}`);
  };
  const pay = (studentId: string, packageId: string, amount: number, verify: boolean) => {
    const p = createPayment(ctx, registrar, {
      studentId,
      packageId,
      amountRwf: amount,
      method: 'momo',
      reference: `TEST-MOMO-${String(ref++).padStart(4, '0')}`,
      notes: 'Test fixture',
    });
    if (verify) transitionPayment(ctx, registrar, p.id, 'verify');
  };

  await mkStudent('TEST-0001', '[TEST] Aline Mukamana', (id) => {
    const p = createPackage(ctx, registrar, id, cal5.id);
    pay(id, p.id, cal5.priceRwf, true);
    activatePackage(ctx, registrar, p.id);
  });
  await mkStudent('TEST-0002', '[TEST] Eric Niyonsenga', (id) => {
    const p = createPackage(ctx, registrar, id, flex10.id);
    pay(id, p.id, flex10.priceRwf, true);
    activatePackage(ctx, registrar, p.id);
  });
  await mkStudent('TEST-0003', '[TEST] Divine Uwase', (id) => {
    const p = createPackage(ctx, registrar, id, cal5.id);
    pay(id, p.id, cal5.priceRwf, false); // recorded, NOT verified → payment_pending
  });
  await mkStudent('TEST-0004', '[TEST] Patrick Habimana', (id) => {
    // Activated 20 days ago → expired.
    const past: Ctx = { ...ctx, clock: () => new Date(Date.now() - 20 * 86400_000) };
    const p = createPackage(past, registrar, id, cal5.id);
    pay(id, p.id, cal5.priceRwf, true);
    activatePackage(past, registrar, p.id);
  });
  await mkStudent(
    'TEST-0005',
    '[TEST] Grace Ingabire',
    () => {},
    { photo: false, confirm: false }, // registration not confirmed → registration_pending
  );
  await mkStudent('TEST-0006', '[TEST] Claude Mugisha', (id) => {
    const p = createPackage(ctx, registrar, id, dinnerOnly.id);
    pay(id, p.id, dinnerOnly.priceRwf, true);
    activatePackage(ctx, registrar, p.id);
  });

  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(path.join(config.dataDir, 'dev-test-devices.json'), JSON.stringify(devices, null, 2));
  const credFile = path.join(config.dataDir, 'dev-credentials.txt');
  writeFileSync(credFile, creds.join('\n') + '\n');

  console.log('\n' + creds.join('\n'));
  console.log(`\n✓ Saved to ${credFile}`);
  console.log('✓ Live test QR codes: set KIZA_DEV_TOOLS=1 and open http://<this-computer>:4000/dev/qr\n');
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
