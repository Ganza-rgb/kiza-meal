import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Institution, StudentDetailResponse, StudentListItem, StudentProfile, StudentStatus } from '@kiza/shared';
import { newId, type Actor, type Ctx } from '../context';
import { all, isUniqueViolation, one, run, transaction } from '../db/db';
import { ApiError, invalidState, notFound } from '../errors';
import { newHumanCode, normaliseHumanCode, sha256 } from '../security/crypto';
import { audit } from './audit';
import { studentClaims } from './claims';
import { studentPackages } from './packages';
import { studentPayments } from './payments';

export interface StudentRow {
  id: string;
  student_number: string;
  full_name: string;
  phone: string | null;
  institution: Institution;
  photo_file: string | null;
  status: StudentStatus;
  password_hash: string | null;
  activation_code_hash: string | null;
  activation_expires_at: string | null;
  failed_logins: number;
  locked_until: string | null;
  created_at: string;
}

export const ACTIVATION_CODE_DAYS = 14;

export function getStudentRow(ctx: Ctx, id: string): StudentRow {
  const row = one<StudentRow>(ctx.db, 'SELECT * FROM students WHERE id = ?', [id]);
  if (!row) throw notFound('Student');
  return row;
}

export const toStudentProfile = (s: StudentRow): StudentProfile => ({
  id: s.id,
  studentNumber: s.student_number,
  fullName: s.full_name,
  institution: s.institution,
  status: s.status,
  hasPhoto: s.photo_file !== null,
});

/** Rwandan numbers are stored as +2507XXXXXXXX so "078…" and "+25078…" are recognised as the same person. */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  if (/^07\d{8}$/.test(digits)) return `+250${digits.slice(1)}`;
  if (/^2507\d{8}$/.test(digits)) return `+${digits}`;
  if (/^\+2507\d{8}$/.test(digits)) return digits;
  throw new ApiError('validation_failed', 'Phone number must be a Rwandan mobile number (07XXXXXXXX)');
}

const LIST_SELECT = `
  SELECT s.id, s.student_number, s.full_name, s.institution, s.status, s.phone, s.photo_file,
         (SELECT p.name FROM packages p
           WHERE p.student_id = s.id AND p.status = 'active' AND p.start_date <= :today AND p.end_date >= :today
           ORDER BY p.end_date LIMIT 1) AS active_package_name
    FROM students s`;

interface ListRow {
  id: string;
  student_number: string;
  full_name: string;
  institution: Institution;
  status: StudentStatus;
  phone: string | null;
  photo_file: string | null;
  active_package_name: string | null;
}

const toListItem = (r: ListRow): StudentListItem => ({
  id: r.id,
  studentNumber: r.student_number,
  fullName: r.full_name,
  institution: r.institution,
  status: r.status,
  phone: r.phone,
  hasPhoto: r.photo_file !== null,
  activePackageName: r.active_package_name,
});

export function searchStudents(ctx: Ctx, q: string, today: string, limit = 30): StudentListItem[] {
  const term = q.trim();
  const like = `%${term.replace(/[%_]/g, '')}%`;
  return all<ListRow>(
    ctx.db,
    `${LIST_SELECT}
      WHERE (:term = '' OR s.student_number LIKE :like OR s.full_name LIKE :like OR s.phone LIKE :like)
      ORDER BY s.updated_at DESC
      LIMIT :limit`,
    { term, like, today, limit },
  ).map(toListItem);
}

export interface RegisterStudentInput {
  studentNumber: string;
  fullName: string;
  phone?: string | null;
  institution: Institution;
}

/** Returns the student and a one-time activation code to hand to the student. */
export function registerStudent(
  ctx: Ctx,
  actor: Actor,
  input: RegisterStudentInput,
): { student: StudentProfile; activationCode: string; activationExpiresAt: string } {
  const id = newId();
  const now = ctx.clock().toISOString();
  const phone = normalisePhone(input.phone);
  const code = newHumanCode(8);
  const expires = new Date(ctx.clock().getTime() + ACTIVATION_CODE_DAYS * 86400_000).toISOString();
  try {
    transaction(ctx.db, () => {
      run(
        ctx.db,
        `INSERT INTO students (id, student_number, full_name, phone, institution, status, activation_code_hash,
                               activation_expires_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        [id, input.studentNumber.trim(), input.fullName.trim(), phone, input.institution, activationCodeHash(code), expires, actor.id, now, now],
      );
      audit(ctx, actor, 'student.register', 'student', id, { studentNumber: input.studentNumber.trim() });
    });
  } catch (err) {
    if (isUniqueViolation(err, 'students.student_number')) {
      throw new ApiError('duplicate_student_number', 'A student with this number is already registered');
    }
    if (isUniqueViolation(err, 'students.phone')) {
      throw new ApiError('duplicate_phone', 'Another student is registered with this phone number');
    }
    throw err;
  }
  return { student: toStudentProfile(getStudentRow(ctx, id)), activationCode: code, activationExpiresAt: expires };
}

export function updateStudent(
  ctx: Ctx,
  actor: Actor & { type: 'staff' },
  id: string,
  patch: { fullName?: string; phone?: string | null; institution?: Institution; status?: StudentStatus; reason?: string },
): StudentProfile {
  const current = getStudentRow(ctx, id);
  if (patch.status && patch.status !== current.status) {
    if (patch.status === 'active' && !current.photo_file) {
      throw invalidState('Add a photo before confirming the registration');
    }
    if (current.status === 'suspended' && actor.role !== 'manager') {
      throw new ApiError('forbidden', 'Only a manager can lift a suspension');
    }
  }
  const phone = patch.phone === undefined ? current.phone : normalisePhone(patch.phone);
  try {
    transaction(ctx.db, () => {
      run(ctx.db, 'UPDATE students SET full_name = ?, phone = ?, institution = ?, status = ?, updated_at = ? WHERE id = ?', [
        patch.fullName?.trim() ?? current.full_name,
        phone,
        patch.institution ?? current.institution,
        patch.status ?? current.status,
        ctx.clock().toISOString(),
        id,
      ]);
      audit(ctx, actor, 'student.update', 'student', id, {
        changed: Object.keys(patch).filter((k) => k !== 'reason'),
        fromStatus: current.status,
        toStatus: patch.status ?? current.status,
        reason: patch.reason ?? null,
      });
    });
  } catch (err) {
    if (isUniqueViolation(err, 'students.phone')) throw new ApiError('duplicate_phone', 'Another student uses this phone number');
    throw err;
  }
  return toStudentProfile(getStudentRow(ctx, id));
}

export function issueActivationCode(ctx: Ctx, actor: Actor, id: string): { activationCode: string; activationExpiresAt: string } {
  getStudentRow(ctx, id);
  const code = newHumanCode(8);
  const expires = new Date(ctx.clock().getTime() + ACTIVATION_CODE_DAYS * 86400_000).toISOString();
  transaction(ctx.db, () => {
    // A new code also resets the password, which is the recovery path for a forgotten password.
    run(ctx.db, 'UPDATE students SET activation_code_hash = ?, activation_expires_at = ?, updated_at = ? WHERE id = ?', [
      activationCodeHash(code),
      expires,
      ctx.clock().toISOString(),
      id,
    ]);
    audit(ctx, actor, 'student.activation_code.issue', 'student', id);
  });
  return { activationCode: code, activationExpiresAt: expires };
}

export const activationCodeHash = (code: string) => sha256(normaliseHumanCode(code));

export function revokeStudentDevices(ctx: Ctx, actor: Actor, studentId: string, reason: string): number {
  return transaction(ctx.db, () => {
    const changes = run(
      ctx.db,
      'UPDATE student_devices SET revoked_at = ?, revoked_reason = ? WHERE student_id = ? AND revoked_at IS NULL',
      [ctx.clock().toISOString(), reason, studentId],
    ).changes;
    audit(ctx, actor, 'student.devices.revoke', 'student', studentId, { reason, count: Number(changes) });
    return Number(changes);
  });
}

export function studentDetail(ctx: Ctx, id: string, today: string): StudentDetailResponse {
  const row = one<ListRow>(ctx.db, `${LIST_SELECT} WHERE s.id = :id`, { id, today });
  if (!row) throw notFound('Student');
  const full = getStudentRow(ctx, id);
  return {
    student: {
      ...toListItem(row),
      accountActivated: full.password_hash !== null,
      activationCodeExpiresAt: full.activation_code_hash ? full.activation_expires_at : null,
      createdAt: full.created_at,
    },
    packages: studentPackages(ctx, id),
    payments: studentPayments(ctx, id),
    claims: studentClaims(ctx, id, 50),
    devices: all<{ id: string; label: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null }>(
      ctx.db,
      'SELECT id, label, created_at, last_used_at, revoked_at FROM student_devices WHERE student_id = ? ORDER BY created_at DESC LIMIT 10',
      [id],
    ).map((d) => ({ id: d.id, label: d.label, createdAt: d.created_at, lastUsedAt: d.last_used_at, revokedAt: d.revoked_at })),
  };
}

// ---------------- Photos (stored on disk, served only to authorised staff and the student) ----------------

const MAX_PHOTO_BYTES = 1_500_000;

function detectImage(buf: Buffer): 'jpg' | 'png' | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

export function saveStudentPhoto(ctx: Ctx, actor: Actor, id: string, base64: string): void {
  getStudentRow(ctx, id);
  const buf = Buffer.from(base64, 'base64');
  if (buf.length === 0 || buf.length > MAX_PHOTO_BYTES) throw new ApiError('validation_failed', 'Photo must be under 1.5 MB');
  const ext = detectImage(buf);
  if (!ext) throw new ApiError('validation_failed', 'Photo must be a JPEG or PNG image');

  mkdirSync(ctx.config.photosDir, { recursive: true });
  const file = `${id}.${ext}`;
  const tmp = path.join(ctx.config.photosDir, `${file}.tmp`);
  writeFileSync(tmp, buf);
  renameSync(tmp, path.join(ctx.config.photosDir, file));
  transaction(ctx.db, () => {
    run(ctx.db, 'UPDATE students SET photo_file = ?, updated_at = ? WHERE id = ?', [file, ctx.clock().toISOString(), id]);
    audit(ctx, actor, 'student.photo.update', 'student', id, { bytes: buf.length });
  });
}

export function readStudentPhoto(ctx: Ctx, id: string): { data: Buffer; mime: string } | null {
  const row = one<{ photo_file: string | null }>(ctx.db, 'SELECT photo_file FROM students WHERE id = ?', [id]);
  if (!row?.photo_file) return null;
  const file = path.join(ctx.config.photosDir, path.basename(row.photo_file));
  if (!existsSync(file)) return null;
  return { data: readFileSync(file), mime: file.endsWith('.png') ? 'image/png' : 'image/jpeg' };
}

/** Buffet staff may only see photos of students their own scanner checked in the last 15 minutes. */
export function scannerRecentlySaw(ctx: Ctx, scannerDeviceId: string, studentId: string): boolean {
  const since = new Date(ctx.clock().getTime() - 15 * 60_000).toISOString();
  return (
    one(ctx.db, 'SELECT 1 AS x FROM scan_attempts WHERE scanner_device_id = ? AND student_id = ? AND created_at >= ? LIMIT 1', [
      scannerDeviceId,
      studentId,
      since,
    ]) !== undefined
  );
}
