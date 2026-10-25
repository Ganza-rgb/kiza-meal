import {
  parseQrPayload,
  QR_MAX_FUTURE_SKEW_SECONDS,
  type BuffetInfo,
  type ClaimSummary,
  type Institution,
  type MealType,
  type RejectionCode,
  type ScanAccepted,
  type ScanRejected,
  type ScanResponse,
  type ScanStudent,
} from '@kiza/shared';
import { newId, type Actor, type Ctx } from '../context';
import { all, isUniqueViolation, one, run, transaction } from '../db/db';
import { ApiError, invalidState, notFound } from '../errors';
import { ed25519PublicKey, verifyEd25519 } from '../security/crypto';
import { addDays, kigaliDate } from '../time';
import { audit } from './audit';
import { currentService } from './settings';

export interface ScannerIdentity {
  deviceId: string;
  buffet: BuffetInfo;
  staffId: string;
}

interface StudentRow {
  id: string;
  student_number: string;
  full_name: string;
  institution: Institution;
  status: 'pending' | 'active' | 'suspended';
  photo_file: string | null;
}

const toScanStudent = (s: StudentRow): ScanStudent => ({
  id: s.id,
  fullName: s.full_name,
  studentNumber: s.student_number,
  institution: s.institution,
  hasPhoto: s.photo_file !== null,
});

// ---------------- Credential verification ----------------

type CredentialCheck = { ok: true; student: StudentRow; studentDeviceId: string } | { ok: false; code: RejectionCode };

function verifyCredential(ctx: Ctx, raw: string): CredentialCheck {
  const parsed = parseQrPayload(raw);
  if (!parsed) return { ok: false, code: 'invalid_qr' };

  const device = one<{ id: string; student_id: string; public_key: string; revoked_at: string | null }>(
    ctx.db,
    'SELECT id, student_id, public_key, revoked_at FROM student_devices WHERE id = ?',
    [parsed.deviceId],
  );
  if (!device) return { ok: false, code: 'invalid_qr' };

  let key;
  try {
    key = ed25519PublicKey(device.public_key);
  } catch {
    return { ok: false, code: 'invalid_qr' };
  }
  // Check the signature before revealing anything about revocation or freshness.
  if (!verifyEd25519(key, parsed.signedMessage, parsed.signature)) return { ok: false, code: 'invalid_qr' };
  if (device.revoked_at) return { ok: false, code: 'revoked_credential' };

  const nowSec = Math.floor(ctx.clock().getTime() / 1000);
  const age = nowSec - parsed.issuedAt;
  if (age > ctx.config.qrMaxAgeSeconds || age < -QR_MAX_FUTURE_SKEW_SECONDS) return { ok: false, code: 'expired_qr' };

  const student = one<StudentRow>(
    ctx.db,
    'SELECT id, student_number, full_name, institution, status, photo_file FROM students WHERE id = ?',
    [device.student_id],
  );
  if (!student) return { ok: false, code: 'unknown_student' };
  return { ok: true, student, studentDeviceId: device.id };
}

// ---------------- Entitlement ----------------

interface CreditPick {
  creditId: string;
  packageId: string;
  mode: 'calendar' | 'flexible';
}

/** Calendar credits for the exact date win; otherwise the flexible credit that expires soonest. */
export function findCredit(ctx: Ctx, studentId: string, date: string, meal: MealType): CreditPick | undefined {
  const dated = one<{ id: string; package_id: string }>(
    ctx.db,
    `SELECT c.id, c.package_id FROM meal_credits c JOIN packages p ON p.id = c.package_id
      WHERE c.student_id = ? AND c.meal = ? AND c.status = 'available' AND c.service_date = ? AND p.status = 'active'
      LIMIT 1`,
    [studentId, meal, date],
  );
  if (dated) return { creditId: dated.id, packageId: dated.package_id, mode: 'calendar' };

  const flexible = one<{ id: string; package_id: string }>(
    ctx.db,
    `SELECT c.id, c.package_id FROM meal_credits c JOIN packages p ON p.id = c.package_id
      WHERE c.student_id = ? AND c.meal = ? AND c.status = 'available' AND c.service_date IS NULL
        AND p.status = 'active' AND p.start_date <= ? AND p.end_date >= ?
      ORDER BY p.end_date, p.activated_at
      LIMIT 1`,
    [studentId, meal, date, date],
  );
  if (flexible) return { creditId: flexible.id, packageId: flexible.package_id, mode: 'flexible' };
  return undefined;
}

/** Explains, in priority order of usefulness to the buffet staff, why no credit is available. */
export function explainNoCredit(ctx: Ctx, studentId: string, date: string, meal: MealType): RejectionCode {
  const pkgs = all<{ status: string; start_date: string | null; end_date: string | null; includes_lunch: number; includes_dinner: number }>(
    ctx.db,
    `SELECT status, start_date, end_date, includes_lunch, includes_dinner FROM packages
      WHERE student_id = ? AND status IN ('active', 'pending_payment')`,
    [studentId],
  );
  const active = pkgs.filter((p) => p.status === 'active');
  const covering = active.filter((p) => p.start_date! <= date && p.end_date! >= date);
  if (covering.length > 0) {
    const includes = covering.some((p) => (meal === 'lunch' ? p.includes_lunch : p.includes_dinner) === 1);
    return includes ? 'no_entitlement' : 'meal_not_included';
  }
  if (pkgs.some((p) => p.status === 'pending_payment')) return 'payment_pending';
  if (active.some((p) => p.start_date! > date)) return 'package_not_started';
  if (active.length > 0) return 'package_expired';
  return 'no_active_package';
}

export function remainingForMeal(ctx: Ctx, studentId: string, date: string, meal: MealType): number {
  const row = one<{ n: number }>(
    ctx.db,
    `SELECT COUNT(*) AS n FROM meal_credits c JOIN packages p ON p.id = c.package_id
      WHERE c.student_id = ? AND c.meal = ? AND c.status = 'available' AND p.status = 'active'
        AND ((c.service_date IS NOT NULL AND c.service_date >= ?) OR (c.service_date IS NULL AND p.end_date >= ?))`,
    [studentId, meal, date, date],
  );
  return row?.n ?? 0;
}

function existingClaim(ctx: Ctx, studentId: string, date: string, meal: MealType) {
  return one<{ id: string; created_at: string; buffet_name: string }>(
    ctx.db,
    `SELECT c.id, c.created_at, b.name AS buffet_name FROM claims c JOIN buffets b ON b.id = c.buffet_id
      WHERE c.student_id = ? AND c.service_date = ? AND c.meal = ? AND c.status = 'confirmed'`,
    [studentId, date, meal],
  );
}

/** Consumes a credit and writes the claim. Must run inside a transaction. */
function writeClaim(
  ctx: Ctx,
  args: {
    studentId: string;
    credit: CreditPick;
    date: string;
    meal: MealType;
    buffetId: string;
    scannerDeviceId: string | null;
    staffId: string;
    source: 'scan' | 'manual';
    idempotencyKey: string | null;
    manualReference?: string | null;
    manualReason?: string | null;
  },
): { claimId: string; createdAt: string } {
  const claimId = newId();
  const createdAt = ctx.clock().toISOString();
  run(
    ctx.db,
    `INSERT INTO claims (id, student_id, credit_id, package_id, service_date, meal, buffet_id, scanner_device_id, staff_id,
                         source, status, idempotency_key, manual_reference, manual_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)`,
    [
      claimId,
      args.studentId,
      args.credit.creditId,
      args.credit.packageId,
      args.date,
      args.meal,
      args.buffetId,
      args.scannerDeviceId,
      args.staffId,
      args.source,
      args.idempotencyKey,
      args.manualReference ?? null,
      args.manualReason ?? null,
      createdAt,
    ],
  );
  const updated = run(
    ctx.db,
    `UPDATE meal_credits SET status = 'claimed', claim_id = ?, service_date = COALESCE(service_date, ?)
      WHERE id = ? AND status = 'available'`,
    [claimId, args.date, args.credit.creditId],
  );
  if (Number(updated.changes) !== 1) throw new Error('Credit was consumed concurrently');
  return { claimId, createdAt };
}

// ---------------- Scan processing (the authoritative decision) ----------------

/**
 * Processes one scan atomically.
 *
 * - The whole decision runs under BEGIN IMMEDIATE, so scans from all three buffets are serialised
 *   by the database; two scans of the same student can never both see an unused entitlement.
 * - The partial unique index claims_one_per_meal_session is a second, independent guard.
 * - The idempotency key makes retries safe: if a response was lost, re-sending the same key returns
 *   the original result (marked replayed) instead of a duplicate rejection or a second claim.
 */
export function processScan(ctx: Ctx, scanner: ScannerIdentity, idempotencyKey: string, qr: string): ScanResponse {
  try {
    return transaction(ctx.db, () => processScanInTx(ctx, scanner, idempotencyKey, qr));
  } catch (err) {
    // A concurrent writer won the race on the same student+meal (only possible across processes
    // sharing the file); report it exactly like any other duplicate.
    if (isUniqueViolation(err, 'claims.student_id') || isUniqueViolation(err, 'meal_credits.student_id')) {
      return transaction(ctx.db, () => processScanInTx(ctx, scanner, idempotencyKey, qr));
    }
    throw err;
  }
}

function processScanInTx(ctx: Ctx, scanner: ScannerIdentity, idempotencyKey: string, qr: string): ScanResponse {
  const prior = one<{ scanner_device_id: string; response_json: string }>(
    ctx.db,
    'SELECT scanner_device_id, response_json FROM scan_attempts WHERE idempotency_key = ?',
    [idempotencyKey],
  );
  if (prior) {
    if (prior.scanner_device_id !== scanner.deviceId) {
      throw new ApiError('conflict', 'This idempotency key belongs to another scanner');
    }
    return { ...(JSON.parse(prior.response_json) as ScanResponse), replayed: true };
  }

  const { date, meal } = currentService(ctx);
  const reject = (code: RejectionCode, student: StudentRow | null, extra?: Partial<ScanRejected>): ScanRejected => ({
    outcome: 'rejected',
    idempotencyKey,
    code,
    student: student ? toScanStudent(student) : null,
    meal,
    serviceDate: date,
    replayed: false,
    ...extra,
  });

  let response: ScanResponse;
  let studentId: string | null = null;
  let claimId: string | null = null;

  const cred = verifyCredential(ctx, qr);
  if (!cred.ok) {
    response = reject(cred.code, null);
  } else {
    const s = cred.student;
    studentId = s.id;
    run(ctx.db, 'UPDATE student_devices SET last_used_at = ? WHERE id = ?', [ctx.clock().toISOString(), cred.studentDeviceId]);

    if (meal === null) response = reject('outside_service_hours', s);
    else if (s.status === 'suspended') response = reject('student_suspended', s);
    else if (s.status === 'pending') response = reject('registration_pending', s);
    else {
      const previous = existingClaim(ctx, s.id, date, meal);
      if (previous) {
        response = reject('duplicate_claim', s, {
          previousClaim: { confirmedAt: previous.created_at, buffetName: previous.buffet_name },
        });
      } else {
        const credit = findCredit(ctx, s.id, date, meal);
        if (!credit) {
          response = reject(explainNoCredit(ctx, s.id, date, meal), s);
        } else {
          const written = writeClaim(ctx, {
            studentId: s.id,
            credit,
            date,
            meal,
            buffetId: scanner.buffet.id,
            scannerDeviceId: scanner.deviceId,
            staffId: scanner.staffId,
            source: 'scan',
            idempotencyKey,
          });
          claimId = written.claimId;
          const accepted: ScanAccepted = {
            outcome: 'accepted',
            idempotencyKey,
            claimId: written.claimId,
            student: toScanStudent(s),
            meal,
            serviceDate: date,
            confirmedAt: written.createdAt,
            buffet: scanner.buffet,
            remainingForMeal: remainingForMeal(ctx, s.id, date, meal),
            replayed: false,
          };
          response = accepted;
        }
      }
    }
  }

  run(
    ctx.db,
    `INSERT INTO scan_attempts (id, idempotency_key, buffet_id, scanner_device_id, staff_id, student_id, service_date, meal,
                                outcome, claim_id, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      idempotencyKey,
      scanner.buffet.id,
      scanner.deviceId,
      scanner.staffId,
      studentId,
      date,
      meal,
      response.outcome === 'accepted' ? 'accepted' : response.code,
      claimId,
      JSON.stringify(response),
      ctx.clock().toISOString(),
    ],
  );
  return response;
}

/** Lets a scanner find out what happened to a request whose response it never received. */
export function lookupScan(ctx: Ctx, scannerDeviceId: string, idempotencyKey: string): ScanResponse | null {
  const row = one<{ scanner_device_id: string; response_json: string }>(
    ctx.db,
    'SELECT scanner_device_id, response_json FROM scan_attempts WHERE idempotency_key = ?',
    [idempotencyKey],
  );
  if (!row || row.scanner_device_id !== scannerDeviceId) return null;
  return { ...(JSON.parse(row.response_json) as ScanResponse), replayed: true };
}

export function recentScans(ctx: Ctx, scannerDeviceId: string, limit = 20) {
  return all<{ response_json: string; created_at: string }>(
    ctx.db,
    'SELECT response_json, created_at FROM scan_attempts WHERE scanner_device_id = ? ORDER BY created_at DESC LIMIT ?',
    [scannerDeviceId, limit],
  ).map((r) => ({ at: r.created_at, result: JSON.parse(r.response_json) as ScanResponse }));
}

// ---------------- Exceptions: manual claims and voids ----------------

/**
 * Records a meal that was served during an outage from the paper log (see docs/OFFLINE_STRATEGY.md).
 * Uses exactly the same entitlement and uniqueness rules as a scan, so a paper entry can never
 * create a second lunch for the same day.
 */
export function recordManualClaim(
  ctx: Ctx,
  actor: Actor & { type: 'staff' },
  input: { studentId: string; serviceDate: string; meal: MealType; buffetId: string; reference: string; reason: string },
): ClaimSummary {
  const today = kigaliDate(ctx.clock());
  if (input.serviceDate > today) throw invalidState('Cannot record a meal in the future');
  if (input.serviceDate < addDays(today, -14)) throw invalidState('Manual claims older than 14 days need a database correction');

  return transaction(ctx.db, () => {
    const buffet = one<{ id: string }>(ctx.db, 'SELECT id FROM buffets WHERE id = ?', [input.buffetId]);
    if (!buffet) throw notFound('Buffet');
    const student = one<StudentRow>(ctx.db, 'SELECT * FROM students WHERE id = ?', [input.studentId]);
    if (!student) throw notFound('Student');

    const prev = existingClaim(ctx, student.id, input.serviceDate, input.meal);
    if (prev) throw invalidState('This meal was already claimed', { code: 'duplicate_claim', previous: prev });
    const credit = findCredit(ctx, student.id, input.serviceDate, input.meal);
    if (!credit) {
      const code = explainNoCredit(ctx, student.id, input.serviceDate, input.meal);
      throw invalidState('Student had no entitlement for that meal', { code });
    }
    const { claimId } = writeClaim(ctx, {
      studentId: student.id,
      credit,
      date: input.serviceDate,
      meal: input.meal,
      buffetId: input.buffetId,
      scannerDeviceId: null,
      staffId: actor.id,
      source: 'manual',
      idempotencyKey: null,
      manualReference: input.reference,
      manualReason: input.reason,
    });
    audit(ctx, actor, 'claim.manual', 'claim', claimId, {
      studentId: student.id,
      serviceDate: input.serviceDate,
      meal: input.meal,
      buffetId: input.buffetId,
      reference: input.reference,
      reason: input.reason,
    });
    return getClaimSummary(ctx, claimId);
  });
}

/** Manager-only correction: voids a claim and returns its credit. Fully audited. */
export function voidClaim(ctx: Ctx, actor: Actor, claimId: string, reason: string): ClaimSummary {
  return transaction(ctx.db, () => {
    const claim = one<{ id: string; status: string; credit_id: string; student_id: string; service_date: string; meal: string }>(
      ctx.db,
      'SELECT id, status, credit_id, student_id, service_date, meal FROM claims WHERE id = ?',
      [claimId],
    );
    if (!claim) throw notFound('Claim');
    if (claim.status !== 'confirmed') throw invalidState('Claim is already voided');
    const credit = one<{ package_id: string }>(ctx.db, 'SELECT package_id FROM meal_credits WHERE id = ?', [claim.credit_id]);
    const pkg = one<{ mode: string }>(ctx.db, 'SELECT mode FROM packages WHERE id = ?', [credit!.package_id]);

    run(ctx.db, `UPDATE claims SET status = 'voided', voided_by = ?, voided_at = ?, void_reason = ? WHERE id = ?`, [
      actor.id,
      ctx.clock().toISOString(),
      reason,
      claim.id,
    ]);
    run(
      ctx.db,
      `UPDATE meal_credits SET status = 'available', claim_id = NULL,
              service_date = CASE WHEN ? = 'flexible' THEN NULL ELSE service_date END
        WHERE id = ?`,
      [pkg!.mode, claim.credit_id],
    );
    audit(ctx, actor, 'claim.void', 'claim', claim.id, {
      reason,
      studentId: claim.student_id,
      serviceDate: claim.service_date,
      meal: claim.meal,
    });
    return getClaimSummary(ctx, claim.id);
  });
}

// ---------------- Read models ----------------

interface ClaimRow {
  id: string;
  service_date: string;
  meal: MealType;
  buffet_name: string;
  created_at: string;
  status: 'confirmed' | 'voided';
  source: 'scan' | 'manual';
}
const toClaimSummary = (r: ClaimRow): ClaimSummary => ({
  id: r.id,
  serviceDate: r.service_date,
  meal: r.meal,
  buffetName: r.buffet_name,
  confirmedAt: r.created_at,
  status: r.status,
  source: r.source,
});

const CLAIM_SELECT = `SELECT c.id, c.service_date, c.meal, b.name AS buffet_name, c.created_at, c.status, c.source
                        FROM claims c JOIN buffets b ON b.id = c.buffet_id`;

export function getClaimSummary(ctx: Ctx, claimId: string): ClaimSummary {
  const row = one<ClaimRow>(ctx.db, `${CLAIM_SELECT} WHERE c.id = ?`, [claimId]);
  if (!row) throw notFound('Claim');
  return toClaimSummary(row);
}

export function studentClaims(ctx: Ctx, studentId: string, limit: number): ClaimSummary[] {
  return all<ClaimRow>(ctx.db, `${CLAIM_SELECT} WHERE c.student_id = ? ORDER BY c.created_at DESC LIMIT ?`, [
    studentId,
    limit,
  ]).map(toClaimSummary);
}
