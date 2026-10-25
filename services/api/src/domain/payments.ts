import type { PaymentListItem, PaymentMethod, PaymentStatus, PaymentSummary } from '@kiza/shared';
import { newId, type Actor, type Ctx } from '../context';
import { all, isUniqueViolation, one, run, transaction } from '../db/db';
import { ApiError, invalidState, notFound } from '../errors';
import { audit } from './audit';

interface PaymentRow {
  id: string;
  student_id: string;
  package_id: string | null;
  amount_rwf: number;
  method: PaymentMethod;
  reference: string | null;
  status: PaymentStatus;
  notes: string | null;
  recorded_at: string;
}

const toSummary = (r: PaymentRow): PaymentSummary => ({
  id: r.id,
  packageId: r.package_id,
  amountRwf: r.amount_rwf,
  method: r.method,
  reference: r.reference,
  status: r.status,
  recordedAt: r.recorded_at,
});

export function studentPayments(ctx: Ctx, studentId: string): PaymentSummary[] {
  return all<PaymentRow>(ctx.db, 'SELECT * FROM payments WHERE student_id = ? ORDER BY recorded_at DESC LIMIT 50', [
    studentId,
  ]).map(toSummary);
}

export interface PaymentInput {
  studentId: string;
  packageId?: string | null;
  amountRwf: number;
  method: PaymentMethod;
  reference?: string | null;
  notes?: string | null;
}

function normaliseReference(ref: string | null | undefined): string | null {
  const v = ref?.trim().toUpperCase();
  return v ? v : null;
}

function checkPackageBelongs(ctx: Ctx, studentId: string, packageId: string | null | undefined) {
  if (!packageId) return;
  const p = one<{ student_id: string; status: string }>(ctx.db, 'SELECT student_id, status FROM packages WHERE id = ?', [packageId]);
  if (!p || p.student_id !== studentId) throw new ApiError('validation_failed', 'Package does not belong to this student');
  if (p.status === 'cancelled') throw invalidState('Package is cancelled');
}

/**
 * Staff record a payment (status "recorded"); a student can only *report* one (status "reported").
 * Neither activates anything — verification is a separate, explicit step.
 */
export function createPayment(ctx: Ctx, actor: Actor, input: PaymentInput): PaymentSummary {
  checkPackageBelongs(ctx, input.studentId, input.packageId);
  const isStudent = actor.type === 'student';
  if (isStudent && actor.id !== input.studentId) throw new ApiError('forbidden', 'Students can only report their own payments');
  const id = newId();
  const now = ctx.clock().toISOString();
  const reference = normaliseReference(input.reference);
  if (input.method === 'momo' && !reference) throw new ApiError('validation_failed', 'MoMo payments need a transaction reference');
  try {
    transaction(ctx.db, () => {
      run(
        ctx.db,
        `INSERT INTO payments (id, student_id, package_id, amount_rwf, method, reference, status, notes,
                               reported_by_student, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.studentId,
          input.packageId ?? null,
          input.amountRwf,
          input.method,
          reference,
          isStudent ? 'reported' : 'recorded',
          input.notes ?? null,
          isStudent ? 1 : 0,
          isStudent ? null : actor.id,
          now,
        ],
      );
      audit(ctx, actor, isStudent ? 'payment.report' : 'payment.record', 'payment', id, {
        studentId: input.studentId,
        packageId: input.packageId ?? null,
        amountRwf: input.amountRwf,
        method: input.method,
        reference,
      });
    });
  } catch (err) {
    if (isUniqueViolation(err, 'payments.method')) {
      throw new ApiError('duplicate_payment_reference', 'This transaction reference has already been used');
    }
    throw err;
  }
  return toSummary(getPaymentRow(ctx, id));
}

function getPaymentRow(ctx: Ctx, id: string): PaymentRow {
  const row = one<PaymentRow>(ctx.db, 'SELECT * FROM payments WHERE id = ?', [id]);
  if (!row) throw notFound('Payment');
  return row;
}

type Transition = 'record' | 'verify' | 'reconcile' | 'reject';
const ALLOWED_FROM: Record<Transition, PaymentStatus[]> = {
  record: ['reported'],
  verify: ['reported', 'recorded'],
  reconcile: ['verified'],
  reject: ['reported', 'recorded', 'verified'],
};

export function transitionPayment(
  ctx: Ctx,
  actor: Actor & { type: 'staff' },
  id: string,
  action: Transition,
  extra: { reason?: string; packageId?: string | null; amountRwf?: number; reference?: string | null } = {},
): PaymentSummary {
  if (action === 'reconcile' && actor.role !== 'manager') throw new ApiError('forbidden', 'Only a manager reconciles payments');
  try {
    transaction(ctx.db, () => {
      const p = getPaymentRow(ctx, id);
      if (!ALLOWED_FROM[action].includes(p.status)) throw invalidState(`Cannot ${action} a payment that is ${p.status}`);
      const now = ctx.clock().toISOString();
      if (action === 'reject' && !extra.reason) throw new ApiError('validation_failed', 'A reason is required');

      // Linking/correcting details is allowed only before verification.
      if (action === 'record' || action === 'verify') {
        const packageId = extra.packageId === undefined ? p.package_id : extra.packageId;
        checkPackageBelongs(ctx, p.student_id, packageId);
        run(ctx.db, 'UPDATE payments SET package_id = ?, amount_rwf = ?, reference = ? WHERE id = ?', [
          packageId,
          extra.amountRwf ?? p.amount_rwf,
          extra.reference === undefined ? p.reference : normaliseReference(extra.reference),
          id,
        ]);
      }
      if (action === 'record') {
        run(ctx.db, `UPDATE payments SET status = 'recorded', recorded_by = ? WHERE id = ?`, [actor.id, id]);
      } else if (action === 'verify') {
        run(
          ctx.db,
          `UPDATE payments SET status = 'verified', verified_by = :actor, verified_at = :now,
                  recorded_by = COALESCE(recorded_by, :actor) WHERE id = :id`,
          { actor: actor.id, now, id },
        );
      } else if (action === 'reconcile') {
        run(ctx.db, `UPDATE payments SET status = 'reconciled', reconciled_by = ?, reconciled_at = ? WHERE id = ?`, [actor.id, now, id]);
      } else {
        run(ctx.db, `UPDATE payments SET status = 'rejected', rejected_by = ?, rejected_at = ?, reject_reason = ? WHERE id = ?`, [
          actor.id,
          now,
          extra.reason!,
          id,
        ]);
      }
      audit(ctx, actor, `payment.${action}`, 'payment', id, { from: p.status, ...extra });
    });
  } catch (err) {
    if (isUniqueViolation(err, 'payments.method')) {
      throw new ApiError('duplicate_payment_reference', 'This transaction reference has already been used');
    }
    throw err;
  }
  return toSummary(getPaymentRow(ctx, id));
}

export function listPayments(ctx: Ctx, filter: { status?: PaymentStatus; studentId?: string; limit: number }): PaymentListItem[] {
  return all<
    PaymentRow & {
      student_name: string;
      student_number: string;
      package_name: string | null;
      recorded_by_name: string | null;
      verified_by_name: string | null;
    }
  >(
    ctx.db,
    `SELECT p.*, s.full_name AS student_name, s.student_number, pk.name AS package_name,
            rb.full_name AS recorded_by_name, vb.full_name AS verified_by_name
       FROM payments p
       JOIN students s ON s.id = p.student_id
       LEFT JOIN packages pk ON pk.id = p.package_id
       LEFT JOIN staff rb ON rb.id = p.recorded_by
       LEFT JOIN staff vb ON vb.id = p.verified_by
      WHERE (:status IS NULL OR p.status = :status) AND (:student IS NULL OR p.student_id = :student)
      ORDER BY p.recorded_at DESC
      LIMIT :limit`,
    { status: filter.status ?? null, student: filter.studentId ?? null, limit: filter.limit },
  ).map((r) => ({
    ...toSummary(r),
    studentId: r.student_id,
    studentName: r.student_name,
    studentNumber: r.student_number,
    packageName: r.package_name,
    recordedByName: r.recorded_by_name,
    verifiedByName: r.verified_by_name,
    notes: r.notes,
  }));
}
