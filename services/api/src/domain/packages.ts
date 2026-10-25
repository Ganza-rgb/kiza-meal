import type { MealType, PackageDisplayStatus, PackageMode, PackageStatus, PackageSummary, PackageType } from '@kiza/shared';
import { newId, type Actor, type Ctx } from '../context';
import { all, bool, one, run, transaction } from '../db/db';
import { ApiError, invalidState, notFound } from '../errors';
import { addDays, kigaliDate, maxDate } from '../time';
import { audit } from './audit';
import { closureSet } from './settings';

// ---------------- Package types (configured by managers) ----------------

interface PackageTypeRow {
  id: string;
  name: string;
  mode: PackageMode;
  meal_days: number;
  validity_days: number;
  price_rwf: number;
  includes_lunch: number;
  includes_dinner: number;
  active: number;
  notes: string | null;
}

const toPackageType = (r: PackageTypeRow): PackageType => ({
  id: r.id,
  name: r.name,
  mode: r.mode,
  mealDays: r.meal_days,
  validityDays: r.validity_days,
  priceRwf: r.price_rwf,
  includesLunch: r.includes_lunch === 1,
  includesDinner: r.includes_dinner === 1,
  active: r.active === 1,
  notes: r.notes,
});

export function listPackageTypes(ctx: Ctx, includeInactive: boolean): PackageType[] {
  return all<PackageTypeRow>(
    ctx.db,
    `SELECT * FROM package_types ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY meal_days, name`,
  ).map(toPackageType);
}

export interface PackageTypeInput {
  name: string;
  mode: PackageMode;
  mealDays: number;
  validityDays?: number;
  priceRwf: number;
  includesLunch: boolean;
  includesDinner: boolean;
  notes?: string | null;
}

function normaliseValidity(input: PackageTypeInput): number {
  // Calendar packages run over consecutive operating days, so validity is not separately configurable.
  if (input.mode === 'calendar') return input.mealDays;
  const validity = input.validityDays ?? input.mealDays;
  if (validity < input.mealDays) throw invalidState('Validity must be at least as long as the number of meal days');
  return validity;
}

export function createPackageType(ctx: Ctx, actor: Actor, input: PackageTypeInput): PackageType {
  if (!input.includesLunch && !input.includesDinner) throw invalidState('A package must include lunch, dinner or both');
  const id = newId();
  const now = ctx.clock().toISOString();
  transaction(ctx.db, () => {
    run(
      ctx.db,
      `INSERT INTO package_types (id, name, mode, meal_days, validity_days, price_rwf, includes_lunch, includes_dinner,
                                  active, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [
        id,
        input.name.trim(),
        input.mode,
        input.mealDays,
        normaliseValidity(input),
        input.priceRwf,
        bool(input.includesLunch),
        bool(input.includesDinner),
        input.notes ?? null,
        actor.id,
        now,
        now,
      ],
    );
    audit(ctx, actor, 'package_type.create', 'package_type', id, { ...input });
  });
  return getPackageType(ctx, id);
}

export function getPackageType(ctx: Ctx, id: string): PackageType {
  const row = one<PackageTypeRow>(ctx.db, 'SELECT * FROM package_types WHERE id = ?', [id]);
  if (!row) throw notFound('Package type');
  return toPackageType(row);
}

/** Only name, price, notes and active flag can change; terms of already-sold packages are snapshotted. */
export function updatePackageType(
  ctx: Ctx,
  actor: Actor,
  id: string,
  patch: { name?: string; priceRwf?: number; notes?: string | null; active?: boolean },
): PackageType {
  const current = getPackageType(ctx, id);
  transaction(ctx.db, () => {
    run(ctx.db, 'UPDATE package_types SET name = ?, price_rwf = ?, notes = ?, active = ?, updated_at = ? WHERE id = ?', [
      patch.name?.trim() ?? current.name,
      patch.priceRwf ?? current.priceRwf,
      patch.notes === undefined ? current.notes : patch.notes,
      bool(patch.active ?? current.active),
      ctx.clock().toISOString(),
      id,
    ]);
    audit(ctx, actor, 'package_type.update', 'package_type', id, { before: current, patch });
  });
  return getPackageType(ctx, id);
}

// ---------------- Student packages ----------------

export interface PackageRow {
  id: string;
  student_id: string;
  package_type_id: string;
  name: string;
  mode: PackageMode;
  meal_days: number;
  validity_days: number;
  price_rwf: number;
  includes_lunch: number;
  includes_dinner: number;
  status: PackageStatus;
  requested_start_date: string;
  start_date: string | null;
  end_date: string | null;
  activated_at: string | null;
  created_at: string;
}

export function getPackageRow(ctx: Ctx, id: string): PackageRow {
  const row = one<PackageRow>(ctx.db, 'SELECT * FROM packages WHERE id = ?', [id]);
  if (!row) throw notFound('Package');
  return row;
}

export function displayStatus(p: Pick<PackageRow, 'status' | 'start_date' | 'end_date'>, today: string): PackageDisplayStatus {
  if (p.status !== 'active') return p.status;
  if (p.start_date && today < p.start_date) return 'scheduled';
  if (p.end_date && today > p.end_date) return 'expired';
  return 'active';
}

/** Sum of payments for this package that staff have actually verified (or reconciled). */
export function verifiedPaidRwf(ctx: Ctx, packageId: string): number {
  const row = one<{ total: number | null }>(
    ctx.db,
    `SELECT SUM(amount_rwf) AS total FROM payments WHERE package_id = ? AND status IN ('verified', 'reconciled')`,
    [packageId],
  );
  return row?.total ?? 0;
}

export function summarisePackages(ctx: Ctx, rows: PackageRow[]): PackageSummary[] {
  const today = kigaliDate(ctx.clock());
  return rows.map((p) => {
    const counts = all<{ meal: MealType; status: string; n: number }>(
      ctx.db,
      `SELECT meal, status, COUNT(*) AS n FROM meal_credits
        WHERE package_id = ?
          AND (status = 'claimed' OR (status = 'available' AND (service_date IS NULL OR service_date >= ?)))
        GROUP BY meal, status`,
      [p.id, today],
    );
    const status = displayStatus(p, today);
    const remaining = { lunch: 0, dinner: 0 };
    const used = { lunch: 0, dinner: 0 };
    for (const c of counts) {
      if (c.status === 'claimed') used[c.meal] += c.n;
      else if (status === 'active' || status === 'scheduled') remaining[c.meal] += c.n;
    }
    return {
      id: p.id,
      name: p.name,
      mode: p.mode,
      status,
      mealDays: p.meal_days,
      includesLunch: p.includes_lunch === 1,
      includesDinner: p.includes_dinner === 1,
      priceRwf: p.price_rwf,
      startDate: p.start_date,
      endDate: p.end_date,
      requestedStartDate: p.requested_start_date,
      remaining,
      used,
      paidVerifiedRwf: verifiedPaidRwf(ctx, p.id),
    };
  });
}

export function studentPackages(ctx: Ctx, studentId: string): PackageSummary[] {
  return summarisePackages(
    ctx,
    all<PackageRow>(ctx.db, 'SELECT * FROM packages WHERE student_id = ? ORDER BY created_at DESC', [studentId]),
  );
}

/** Registration staff sell a package. It stays `pending_payment` until a verified payment covers it. */
export function createPackage(
  ctx: Ctx,
  actor: Actor,
  studentId: string,
  packageTypeId: string,
  requestedStartDate?: string,
): PackageSummary {
  const type = getPackageType(ctx, packageTypeId);
  if (!type.active) throw invalidState('This package type is no longer offered');
  const student = one<{ status: string }>(ctx.db, 'SELECT status FROM students WHERE id = ?', [studentId]);
  if (!student) throw notFound('Student');
  if (student.status === 'suspended') throw invalidState('Student account is suspended');

  const today = kigaliDate(ctx.clock());
  const start = requestedStartDate ?? today;
  if (start < today) throw invalidState('Start date cannot be in the past');

  const id = newId();
  transaction(ctx.db, () => {
    run(
      ctx.db,
      `INSERT INTO packages (id, student_id, package_type_id, name, mode, meal_days, validity_days, price_rwf,
                             includes_lunch, includes_dinner, status, requested_start_date, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?)`,
      [
        id,
        studentId,
        type.id,
        type.name,
        type.mode,
        type.mealDays,
        type.validityDays,
        type.priceRwf,
        bool(type.includesLunch),
        bool(type.includesDinner),
        start,
        actor.id,
        ctx.clock().toISOString(),
      ],
    );
    audit(ctx, actor, 'package.create', 'package', id, { studentId, packageTypeId, priceRwf: type.priceRwf, start });
  });
  return summarisePackages(ctx, [getPackageRow(ctx, id)])[0]!;
}

/**
 * Activation generates the meal credits. Requirements:
 *  - status pending_payment
 *  - verified/reconciled payments cover the snapshotted price (a zero-price package needs a manager)
 *  - the student's registration is active
 * Calendar packages start no earlier than the day after the student's last calendar package ends,
 * so renewals queue up instead of overlapping.
 */
export function activatePackage(ctx: Ctx, actor: Actor, packageId: string): PackageSummary {
  if (actor.type !== 'staff') throw new ApiError('forbidden', 'Only staff can activate packages');
  transaction(ctx.db, () => {
    const p = getPackageRow(ctx, packageId);
    if (p.status !== 'pending_payment') throw invalidState(`Package is ${p.status}, not awaiting activation`);

    const student = one<{ status: string }>(ctx.db, 'SELECT status FROM students WHERE id = ?', [p.student_id]);
    if (student?.status !== 'active') throw invalidState('Student registration must be confirmed before activation');

    const paid = verifiedPaidRwf(ctx, p.id);
    if (p.price_rwf === 0 && actor.role !== 'manager') {
      throw new ApiError('forbidden', 'Only a manager can activate a zero-price package');
    }
    if (paid < p.price_rwf) {
      throw new ApiError('payment_insufficient', 'Verified payments do not cover the package price', {
        priceRwf: p.price_rwf,
        verifiedRwf: paid,
      });
    }

    const today = kigaliDate(ctx.clock());
    let start = maxDate(p.requested_start_date, today);
    const now = ctx.clock().toISOString();
    let end: string;

    if (p.mode === 'calendar') {
      const last = one<{ end_date: string | null }>(
        ctx.db,
        `SELECT MAX(end_date) AS end_date FROM packages
          WHERE student_id = ? AND status = 'active' AND mode = 'calendar' AND id <> ?`,
        [p.student_id, p.id],
      );
      if (last?.end_date && last.end_date >= start) start = addDays(last.end_date, 1);
      const closed = closureSet(ctx, start);
      const dates: string[] = [];
      for (let d = start; dates.length < p.meal_days; d = addDays(d, 1)) {
        if (!closed.has(d)) dates.push(d);
        if (d > addDays(start, 800)) throw invalidState('Too many closure days to schedule this package');
      }
      start = dates[0]!;
      end = dates[dates.length - 1]!;
      for (const date of dates) {
        if (p.includes_lunch) insertCredit(ctx, p, 'lunch', date, now);
        if (p.includes_dinner) insertCredit(ctx, p, 'dinner', date, now);
      }
    } else {
      end = addDays(start, p.validity_days - 1);
      for (let i = 0; i < p.meal_days; i++) {
        if (p.includes_lunch) insertCredit(ctx, p, 'lunch', null, now);
        if (p.includes_dinner) insertCredit(ctx, p, 'dinner', null, now);
      }
    }

    run(
      ctx.db,
      `UPDATE packages SET status = 'active', start_date = ?, end_date = ?, activated_by = ?, activated_at = ? WHERE id = ?`,
      [start, end, actor.id, now, p.id],
    );
    audit(ctx, actor, 'package.activate', 'package', p.id, { start, end, verifiedRwf: paid });
  });
  return summarisePackages(ctx, [getPackageRow(ctx, packageId)])[0]!;
}

function insertCredit(ctx: Ctx, p: PackageRow, meal: MealType, date: string | null, now: string) {
  run(
    ctx.db,
    `INSERT INTO meal_credits (id, package_id, student_id, meal, service_date, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'available', ?)`,
    [newId(), p.id, p.student_id, meal, date, now],
  );
}

/** Managers can cancel; unused credits are voided, used ones stay as history. Refunds are handled outside the app. */
export function cancelPackage(ctx: Ctx, actor: Actor, packageId: string, reason: string): PackageSummary {
  transaction(ctx.db, () => {
    const p = getPackageRow(ctx, packageId);
    if (p.status === 'cancelled') throw invalidState('Package is already cancelled');
    const voided = run(ctx.db, `UPDATE meal_credits SET status = 'void' WHERE package_id = ? AND status = 'available'`, [
      p.id,
    ]).changes;
    run(ctx.db, `UPDATE packages SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, cancel_reason = ? WHERE id = ?`, [
      actor.id,
      ctx.clock().toISOString(),
      reason,
      p.id,
    ]);
    audit(ctx, actor, 'package.cancel', 'package', p.id, { reason, voidedCredits: Number(voided), previous: p.status });
  });
  return summarisePackages(ctx, [getPackageRow(ctx, packageId)])[0]!;
}
