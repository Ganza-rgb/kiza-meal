import type {
  BuffetInfo,
  EnrollResponse,
  ScannerDeviceInfo,
  StaffLoginResponse,
  StaffProfile,
  StaffRole,
  StudentDeviceResponse,
  StudentLoginResponse,
} from '@kiza/shared';
import { newId, type Actor, type Ctx } from '../context';
import { all, bool, isUniqueViolation, one, run, transaction } from '../db/db';
import { ApiError, invalidState, notFound } from '../errors';
import {
  burnPasswordCheck,
  ed25519PublicKey,
  hashPassword,
  newHumanCode,
  newToken,
  normaliseHumanCode,
  sha256,
  verifyPassword,
} from '../security/crypto';
import { audit } from './audit';
import { activationCodeHash, getStudentRow, toStudentProfile } from './students';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 10;
export const MIN_PASSWORD_LENGTH = 8;

// ---------------- Sessions ----------------

export interface SessionInfo {
  sessionId: string;
  subjectType: 'staff' | 'student';
  subjectId: string;
  scannerDeviceId: string | null;
}

function createSession(
  ctx: Ctx,
  subjectType: 'staff' | 'student',
  subjectId: string,
  ttlMs: number,
  scannerDeviceId: string | null,
): { token: string; expiresAt: string } {
  const token = newToken();
  const now = ctx.clock();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  run(
    ctx.db,
    `INSERT INTO sessions (id, token_hash, subject_type, subject_id, scanner_device_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [newId(), sha256(token), subjectType, subjectId, scannerDeviceId, now.toISOString(), expiresAt],
  );
  return { token, expiresAt };
}

export function resolveSession(ctx: Ctx, token: string): SessionInfo | null {
  const row = one<{
    id: string;
    subject_type: 'staff' | 'student';
    subject_id: string;
    scanner_device_id: string | null;
    expires_at: string;
    revoked_at: string | null;
  }>(ctx.db, 'SELECT id, subject_type, subject_id, scanner_device_id, expires_at, revoked_at FROM sessions WHERE token_hash = ?', [
    sha256(token),
  ]);
  const now = ctx.clock().toISOString();
  if (!row || row.revoked_at || row.expires_at <= now) return null;
  return { sessionId: row.id, subjectType: row.subject_type, subjectId: row.subject_id, scannerDeviceId: row.scanner_device_id };
}

export function revokeSession(ctx: Ctx, sessionId: string): void {
  run(ctx.db, 'UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [ctx.clock().toISOString(), sessionId]);
}

function revokeSubjectSessions(ctx: Ctx, subjectType: 'staff' | 'student', subjectId: string): void {
  run(ctx.db, 'UPDATE sessions SET revoked_at = ? WHERE subject_type = ? AND subject_id = ? AND revoked_at IS NULL', [
    ctx.clock().toISOString(),
    subjectType,
    subjectId,
  ]);
}

// ---------------- Lockout helpers ----------------

function checkLock(ctx: Ctx, lockedUntil: string | null): void {
  if (lockedUntil && lockedUntil > ctx.clock().toISOString()) {
    throw new ApiError('account_locked', 'Too many failed attempts. Try again later.', { lockedUntil });
  }
}

function recordFailure(ctx: Ctx, table: 'staff' | 'students', id: string, failed: number): void {
  const next = failed + 1;
  const lockedUntil = next >= MAX_FAILED_LOGINS ? new Date(ctx.clock().getTime() + LOCK_MINUTES * 60_000).toISOString() : null;
  run(ctx.db, `UPDATE ${table} SET failed_logins = ?, locked_until = ? WHERE id = ?`, [
    lockedUntil ? 0 : next,
    lockedUntil,
    id,
  ]);
}

function clearFailures(ctx: Ctx, table: 'staff' | 'students', id: string): void {
  run(ctx.db, `UPDATE ${table} SET failed_logins = 0, locked_until = NULL WHERE id = ?`, [id]);
}

// ---------------- Staff ----------------

interface StaffRow {
  id: string;
  username: string;
  full_name: string;
  role: StaffRole;
  password_hash: string;
  must_change_password: number;
  active: number;
  failed_logins: number;
  locked_until: string | null;
}

export const toStaffProfile = (s: StaffRow): StaffProfile => ({
  id: s.id,
  username: s.username,
  fullName: s.full_name,
  role: s.role,
  mustChangePassword: s.must_change_password === 1,
});

export function getStaffRow(ctx: Ctx, id: string): StaffRow | undefined {
  return one<StaffRow>(ctx.db, 'SELECT * FROM staff WHERE id = ?', [id]);
}

export async function loginStaff(
  ctx: Ctx,
  username: string,
  password: string,
  deviceToken: string | null,
): Promise<StaffLoginResponse> {
  const staff = one<StaffRow>(ctx.db, 'SELECT * FROM staff WHERE username = ?', [username.trim()]);
  if (!staff) {
    await burnPasswordCheck(password);
    throw new ApiError('invalid_credentials', 'Wrong username or password');
  }
  checkLock(ctx, staff.locked_until);
  const ok = await verifyPassword(password, staff.password_hash);
  if (!ok) {
    transaction(ctx.db, () => {
      recordFailure(ctx, 'staff', staff.id, staff.failed_logins);
      audit(ctx, { type: 'staff', id: staff.id, role: staff.role, name: staff.full_name }, 'auth.staff.login_failed', 'staff', staff.id);
    });
    throw new ApiError('invalid_credentials', 'Wrong username or password');
  }
  if (staff.active !== 1) throw new ApiError('account_inactive', 'This staff account is disabled');

  const device = deviceToken ? resolveScannerDevice(ctx, deviceToken) : null;
  if (deviceToken && !device) throw new ApiError('device_revoked', 'This scanning phone is no longer authorised');
  // Buffet staff can only work from an enrolled scanning phone; that is what binds a claim to a buffet.
  if (staff.role === 'buffet_staff' && !device) throw new ApiError('device_required', 'Enrol this phone as a buffet scanner first');

  const actor: Actor = { type: 'staff', id: staff.id, role: staff.role, name: staff.full_name };
  const session = transaction(ctx.db, () => {
    clearFailures(ctx, 'staff', staff.id);
    const s = createSession(ctx, 'staff', staff.id, ctx.config.staffSessionHours * 3600_000, device?.id ?? null);
    audit(ctx, actor, 'auth.staff.login', 'staff', staff.id, { scannerDeviceId: device?.id ?? null });
    return s;
  });
  return { ...session, staff: toStaffProfile(staff), device };
}

export async function changeStaffPassword(ctx: Ctx, staffId: string, current: string, next: string): Promise<void> {
  const staff = getStaffRow(ctx, staffId);
  if (!staff) throw notFound('Staff');
  if (!(await verifyPassword(current, staff.password_hash))) throw new ApiError('invalid_credentials', 'Current password is wrong');
  assertPasswordStrength(next);
  if (current === next) throw new ApiError('validation_failed', 'Choose a new password');
  const hash = await hashPassword(next);
  transaction(ctx.db, () => {
    run(ctx.db, 'UPDATE staff SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?', [
      hash,
      ctx.clock().toISOString(),
      staffId,
    ]);
    audit(ctx, { type: 'staff', id: staff.id, role: staff.role, name: staff.full_name }, 'auth.staff.password_change', 'staff', staffId);
  });
}

export function assertPasswordStrength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ApiError('validation_failed', `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

export async function createStaff(
  ctx: Ctx,
  actor: Actor,
  input: { username: string; fullName: string; role: StaffRole; password: string },
): Promise<StaffProfile> {
  assertPasswordStrength(input.password);
  const id = newId();
  const now = ctx.clock().toISOString();
  const hash = await hashPassword(input.password);
  try {
    transaction(ctx.db, () => {
      run(
        ctx.db,
        `INSERT INTO staff (id, username, full_name, role, password_hash, must_change_password, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`,
        [id, input.username.trim(), input.fullName.trim(), input.role, hash, now, now],
      );
      audit(ctx, actor, 'staff.create', 'staff', id, { username: input.username.trim(), role: input.role });
    });
  } catch (err) {
    if (isUniqueViolation(err, 'staff.username')) throw new ApiError('conflict', 'That username is taken');
    throw err;
  }
  return toStaffProfile(getStaffRow(ctx, id)!);
}

export async function updateStaff(
  ctx: Ctx,
  actor: Actor & { type: 'staff' },
  id: string,
  patch: { fullName?: string; role?: StaffRole; active?: boolean; password?: string },
): Promise<StaffProfile> {
  const current = getStaffRow(ctx, id);
  if (!current) throw notFound('Staff');
  if (id === actor.id && (patch.active === false || (patch.role && patch.role !== 'manager'))) {
    throw invalidState('You cannot disable or demote your own account');
  }
  if (patch.password !== undefined) assertPasswordStrength(patch.password);
  const hash = patch.password !== undefined ? await hashPassword(patch.password) : null;
  transaction(ctx.db, () => {
    run(
      ctx.db,
      `UPDATE staff SET full_name = ?, role = ?, active = ?, password_hash = COALESCE(?, password_hash),
              must_change_password = CASE WHEN ? IS NULL THEN must_change_password ELSE 1 END, updated_at = ?
        WHERE id = ?`,
      [
        patch.fullName?.trim() ?? current.full_name,
        patch.role ?? current.role,
        bool(patch.active ?? current.active === 1),
        hash,
        hash,
        ctx.clock().toISOString(),
        id,
      ],
    );
    // Any change to role, status or password ends existing sessions (e.g. a phone left logged in).
    if (patch.role || patch.active === false || hash) revokeSubjectSessions(ctx, 'staff', id);
    audit(ctx, actor, 'staff.update', 'staff', id, {
      fullName: patch.fullName,
      role: patch.role,
      active: patch.active,
      passwordReset: hash !== null,
    });
  });
  return toStaffProfile(getStaffRow(ctx, id)!);
}

export function listStaff(ctx: Ctx): (StaffProfile & { active: boolean; lastLoginAt: string | null })[] {
  return all<StaffRow & { last_login: string | null }>(
    ctx.db,
    `SELECT s.*, (SELECT MAX(created_at) FROM sessions WHERE subject_type = 'staff' AND subject_id = s.id) AS last_login
       FROM staff s ORDER BY s.active DESC, s.full_name`,
  ).map((s) => ({ ...toStaffProfile(s), active: s.active === 1, lastLoginAt: s.last_login }));
}

// ---------------- Scanner devices (one per buffet phone) ----------------

export function listBuffets(ctx: Ctx): BuffetInfo[] {
  return all<BuffetInfo>(ctx.db, 'SELECT id, code, name FROM buffets WHERE active = 1 ORDER BY code');
}

export function resolveScannerDevice(ctx: Ctx, deviceToken: string): ScannerDeviceInfo | null {
  const row = one<{ id: string; label: string; revoked_at: string | null; buffet_id: string; code: string; name: string }>(
    ctx.db,
    `SELECT d.id, d.label, d.revoked_at, b.id AS buffet_id, b.code, b.name
       FROM scanner_devices d JOIN buffets b ON b.id = d.buffet_id
      WHERE d.token_hash = ?`,
    [sha256(deviceToken)],
  );
  if (!row || row.revoked_at) return null;
  return { id: row.id, label: row.label, buffet: { id: row.buffet_id, code: row.code, name: row.name } };
}

export function touchScannerDevice(ctx: Ctx, deviceId: string): void {
  run(ctx.db, 'UPDATE scanner_devices SET last_seen_at = ? WHERE id = ?', [ctx.clock().toISOString(), deviceId]);
}

export function getScannerDevice(ctx: Ctx, deviceId: string): (ScannerDeviceInfo & { revoked: boolean }) | null {
  const row = one<{ id: string; label: string; revoked_at: string | null; buffet_id: string; code: string; name: string }>(
    ctx.db,
    `SELECT d.id, d.label, d.revoked_at, b.id AS buffet_id, b.code, b.name
       FROM scanner_devices d JOIN buffets b ON b.id = d.buffet_id WHERE d.id = ?`,
    [deviceId],
  );
  if (!row) return null;
  return { id: row.id, label: row.label, revoked: row.revoked_at !== null, buffet: { id: row.buffet_id, code: row.code, name: row.name } };
}

const ENROLLMENT_HOURS = 24;

/** A manager creates a scanner slot and gets a one-time enrolment code to type on the buffet phone. */
export function createScannerDevice(
  ctx: Ctx,
  actor: Actor,
  buffetId: string,
  label: string,
): { id: string; enrollmentCode: string; expiresAt: string } {
  const buffet = one(ctx.db, 'SELECT id FROM buffets WHERE id = ? AND active = 1', [buffetId]);
  if (!buffet) throw notFound('Buffet');
  const id = newId();
  const { code, expiresAt } = newEnrollmentCode(ctx);
  transaction(ctx.db, () => {
    run(
      ctx.db,
      `INSERT INTO scanner_devices (id, buffet_id, label, enrollment_code_hash, enrollment_expires_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, buffetId, label.trim(), sha256(code), expiresAt, actor.id, ctx.clock().toISOString()],
    );
    audit(ctx, actor, 'scanner_device.create', 'scanner_device', id, { buffetId, label });
  });
  return { id, enrollmentCode: code, expiresAt };
}

function newEnrollmentCode(ctx: Ctx) {
  return { code: newHumanCode(8), expiresAt: new Date(ctx.clock().getTime() + ENROLLMENT_HOURS * 3600_000).toISOString() };
}

/** Re-enrolment (e.g. replacement phone) invalidates the old phone's token immediately. */
export function reissueEnrollment(ctx: Ctx, actor: Actor, deviceId: string): { enrollmentCode: string; expiresAt: string } {
  const { code, expiresAt } = newEnrollmentCode(ctx);
  transaction(ctx.db, () => {
    const changed = run(
      ctx.db,
      `UPDATE scanner_devices SET enrollment_code_hash = ?, enrollment_expires_at = ?, token_hash = NULL, revoked_at = NULL
        WHERE id = ?`,
      [sha256(code), expiresAt, deviceId],
    ).changes;
    if (Number(changed) === 0) throw notFound('Scanner device');
    revokeDeviceSessions(ctx, deviceId);
    audit(ctx, actor, 'scanner_device.reissue', 'scanner_device', deviceId);
  });
  return { enrollmentCode: code, expiresAt };
}

function revokeDeviceSessions(ctx: Ctx, deviceId: string) {
  run(ctx.db, 'UPDATE sessions SET revoked_at = ? WHERE scanner_device_id = ? AND revoked_at IS NULL', [
    ctx.clock().toISOString(),
    deviceId,
  ]);
}

/** Lost or stolen phone: revoke it and every session on it. */
export function revokeScannerDevice(ctx: Ctx, actor: Actor, deviceId: string): void {
  transaction(ctx.db, () => {
    const changed = run(
      ctx.db,
      'UPDATE scanner_devices SET revoked_at = ?, token_hash = NULL, enrollment_code_hash = NULL WHERE id = ?',
      [ctx.clock().toISOString(), deviceId],
    ).changes;
    if (Number(changed) === 0) throw notFound('Scanner device');
    revokeDeviceSessions(ctx, deviceId);
    audit(ctx, actor, 'scanner_device.revoke', 'scanner_device', deviceId);
  });
}

export function enrollScannerDevice(ctx: Ctx, code: string): EnrollResponse {
  const hash = sha256(normaliseHumanCode(code));
  return transaction(ctx.db, () => {
    const row = one<{ id: string; enrollment_expires_at: string | null; revoked_at: string | null }>(
      ctx.db,
      'SELECT id, enrollment_expires_at, revoked_at FROM scanner_devices WHERE enrollment_code_hash = ?',
      [hash],
    );
    const now = ctx.clock().toISOString();
    if (!row || row.revoked_at || !row.enrollment_expires_at || row.enrollment_expires_at <= now) {
      throw new ApiError('enrollment_invalid', 'Enrolment code is wrong or expired');
    }
    const deviceToken = newToken();
    run(
      ctx.db,
      `UPDATE scanner_devices SET token_hash = ?, enrollment_code_hash = NULL, enrollment_expires_at = NULL,
              enrolled_at = ?, last_seen_at = ? WHERE id = ?`,
      [sha256(deviceToken), now, now, row.id],
    );
    audit(ctx, { type: 'system', id: null }, 'scanner_device.enroll', 'scanner_device', row.id);
    const device = getScannerDevice(ctx, row.id)!;
    return { deviceToken, device: { id: device.id, label: device.label, buffet: device.buffet } };
  });
}

export function listScannerDevices(ctx: Ctx) {
  return all<{
    id: string;
    label: string;
    buffet_code: string;
    buffet_name: string;
    enrolled_at: string | null;
    last_seen_at: string | null;
    revoked_at: string | null;
    enrollment_expires_at: string | null;
  }>(
    ctx.db,
    `SELECT d.id, d.label, b.code AS buffet_code, b.name AS buffet_name, d.enrolled_at, d.last_seen_at, d.revoked_at,
            d.enrollment_expires_at
       FROM scanner_devices d JOIN buffets b ON b.id = d.buffet_id
      ORDER BY b.code, d.created_at`,
  ).map((d) => ({
    id: d.id,
    label: d.label,
    buffetCode: d.buffet_code,
    buffetName: d.buffet_name,
    enrolledAt: d.enrolled_at,
    lastSeenAt: d.last_seen_at,
    revokedAt: d.revoked_at,
    enrollmentPendingUntil: d.enrollment_expires_at,
  }));
}

// ---------------- Students ----------------

export async function activateStudentAccount(
  ctx: Ctx,
  studentNumber: string,
  code: string,
  password: string,
): Promise<StudentLoginResponse> {
  assertPasswordStrength(password);
  const s = one<{ id: string; activation_code_hash: string | null; activation_expires_at: string | null; failed_logins: number; locked_until: string | null }>(
    ctx.db,
    'SELECT id, activation_code_hash, activation_expires_at, failed_logins, locked_until FROM students WHERE student_number = ?',
    [studentNumber.trim()],
  );
  if (!s) throw new ApiError('activation_invalid', 'Student number or code is wrong');
  checkLock(ctx, s.locked_until);
  const now = ctx.clock().toISOString();
  if (!s.activation_code_hash || s.activation_code_hash !== activationCodeHash(code) || !s.activation_expires_at || s.activation_expires_at <= now) {
    recordFailure(ctx, 'students', s.id, s.failed_logins);
    throw new ApiError('activation_invalid', 'Student number or code is wrong or expired');
  }
  const hash = await hashPassword(password);
  const session = transaction(ctx.db, () => {
    run(
      ctx.db,
      `UPDATE students SET password_hash = ?, activation_code_hash = NULL, activation_expires_at = NULL,
              failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
      [hash, now, s.id],
    );
    // Setting a password (first time or recovery) logs out every other phone and invalidates old passes.
    revokeSubjectSessions(ctx, 'student', s.id);
    run(ctx.db, `UPDATE student_devices SET revoked_at = ?, revoked_reason = 'password_reset' WHERE student_id = ? AND revoked_at IS NULL`, [
      now,
      s.id,
    ]);
    audit(ctx, { type: 'student', id: s.id }, 'auth.student.activate', 'student', s.id);
    return createSession(ctx, 'student', s.id, ctx.config.studentSessionDays * 86400_000, null);
  });
  return { ...session, student: toStudentProfile(getStudentRow(ctx, s.id)) };
}

export async function loginStudent(ctx: Ctx, studentNumber: string, password: string): Promise<StudentLoginResponse> {
  const s = one<{ id: string; password_hash: string | null; failed_logins: number; locked_until: string | null }>(
    ctx.db,
    'SELECT id, password_hash, failed_logins, locked_until FROM students WHERE student_number = ?',
    [studentNumber.trim()],
  );
  if (!s || !s.password_hash) {
    await burnPasswordCheck(password);
    throw new ApiError('invalid_credentials', 'Wrong student number or password');
  }
  checkLock(ctx, s.locked_until);
  if (!(await verifyPassword(password, s.password_hash))) {
    recordFailure(ctx, 'students', s.id, s.failed_logins);
    throw new ApiError('invalid_credentials', 'Wrong student number or password');
  }
  const session = transaction(ctx.db, () => {
    clearFailures(ctx, 'students', s.id);
    audit(ctx, { type: 'student', id: s.id }, 'auth.student.login', 'student', s.id);
    return createSession(ctx, 'student', s.id, ctx.config.studentSessionDays * 86400_000, null);
  });
  return { ...session, student: toStudentProfile(getStudentRow(ctx, s.id)) };
}

/**
 * Registers the public half of the key pair the student's phone just generated.
 * Only one phone can hold a valid pass at a time: registering a new one revokes the previous.
 */
export function registerStudentDevice(ctx: Ctx, studentId: string, publicKey: string, label: string | null): StudentDeviceResponse {
  try {
    ed25519PublicKey(publicKey);
  } catch {
    throw new ApiError('validation_failed', 'Invalid public key');
  }
  const id = newToken(16); // 22-char base64url id that appears in the QR (not the student number)
  const now = ctx.clock().toISOString();
  transaction(ctx.db, () => {
    const revoked = run(
      ctx.db,
      `UPDATE student_devices SET revoked_at = ?, revoked_reason = 'replaced' WHERE student_id = ? AND revoked_at IS NULL`,
      [now, studentId],
    ).changes;
    run(ctx.db, 'INSERT INTO student_devices (id, student_id, public_key, label, created_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      studentId,
      publicKey,
      label,
      now,
    ]);
    audit(ctx, { type: 'student', id: studentId }, 'student.device.register', 'student_device', id, {
      replacedCount: Number(revoked),
    });
  });
  return { deviceId: id, serverTime: now };
}

export function studentDeviceStatus(ctx: Ctx, studentId: string, deviceId: string): 'active' | 'revoked' | 'unknown' {
  const row = one<{ revoked_at: string | null }>(ctx.db, 'SELECT revoked_at FROM student_devices WHERE id = ? AND student_id = ?', [
    deviceId,
    studentId,
  ]);
  if (!row) return 'unknown';
  return row.revoked_at ? 'revoked' : 'active';
}
