import type { MealType, RejectionCode, ReportSummary } from '@kiza/shared';
import type { Ctx } from '../context';
import { all, one } from '../db/db';
import { addDays, kigaliDate, kigaliDayStartUtc } from '../time';

/** Inclusive Kigali date range [from, to] → half-open UTC instant range. */
function utcRange(from: string, to: string) {
  return { fromUtc: kigaliDayStartUtc(from), toUtc: kigaliDayStartUtc(addDays(to, 1)) };
}

export function reportSummary(ctx: Ctx, from: string, to: string): ReportSummary {
  const { fromUtc, toUtc } = utcRange(from, to);
  const db = ctx.db;
  const today = kigaliDate(ctx.clock());

  const byBuffetRows = all<{ code: string; name: string; meal: MealType; n: number }>(
    db,
    `SELECT b.code, b.name, c.meal, COUNT(*) AS n
       FROM buffets b LEFT JOIN claims c
         ON c.buffet_id = b.id AND c.status = 'confirmed' AND c.service_date BETWEEN ? AND ?
      GROUP BY b.code, b.name, c.meal ORDER BY b.code`,
    [from, to],
  );
  const byBuffet = new Map<string, { buffetCode: string; buffetName: string; lunch: number; dinner: number }>();
  for (const r of byBuffetRows) {
    const entry = byBuffet.get(r.code) ?? { buffetCode: r.code, buffetName: r.name, lunch: 0, dinner: 0 };
    if (r.meal) entry[r.meal] += r.n;
    byBuffet.set(r.code, entry);
  }

  const byDayRows = all<{ service_date: string; meal: MealType; n: number }>(
    db,
    `SELECT service_date, meal, COUNT(*) AS n FROM claims
      WHERE status = 'confirmed' AND service_date BETWEEN ? AND ?
      GROUP BY service_date, meal ORDER BY service_date`,
    [from, to],
  );
  const byDay = new Map<string, { date: string; lunch: number; dinner: number }>();
  for (const r of byDayRows) {
    const entry = byDay.get(r.service_date) ?? { date: r.service_date, lunch: 0, dinner: 0 };
    entry[r.meal] += r.n;
    byDay.set(r.service_date, entry);
  }
  const byMeal = { lunch: 0, dinner: 0 };
  for (const d of byDay.values()) {
    byMeal.lunch += d.lunch;
    byMeal.dinner += d.dinner;
  }

  const rejections = all<{ outcome: RejectionCode; n: number }>(
    db,
    `SELECT outcome, COUNT(*) AS n FROM scan_attempts
      WHERE outcome <> 'accepted' AND service_date BETWEEN ? AND ?
      GROUP BY outcome ORDER BY n DESC`,
    [from, to],
  ).map((r) => ({ code: r.outcome, count: r.n }));

  const pk = one<{ created: number; activated: number; value: number | null; pending: number }>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM packages WHERE created_at >= :f AND created_at < :t) AS created,
       (SELECT COUNT(*) FROM packages WHERE activated_at >= :f AND activated_at < :t) AS activated,
       (SELECT SUM(price_rwf) FROM packages WHERE activated_at >= :f AND activated_at < :t) AS value,
       (SELECT COUNT(*) FROM packages WHERE status = 'pending_payment') AS pending`,
    { f: fromUtc, t: toUtc },
  )!;

  const pay = all<{ status: string; total: number | null; n: number }>(
    db,
    `SELECT status, SUM(amount_rwf) AS total, COUNT(*) AS n FROM payments
      WHERE recorded_at >= ? AND recorded_at < ? GROUP BY status`,
    [fromUtc, toUtc],
  );
  const payTotal = (s: string) => pay.find((p) => p.status === s)?.total ?? 0;

  const activeStudents = one<{ n: number }>(
    db,
    `SELECT COUNT(DISTINCT student_id) AS n FROM packages
      WHERE status = 'active' AND start_date <= ? AND end_date >= ?`,
    [today, today],
  )!.n;

  const remaining = all<{ meal: MealType; n: number }>(
    db,
    `SELECT c.meal, COUNT(*) AS n FROM meal_credits c JOIN packages p ON p.id = c.package_id
      WHERE c.status = 'available' AND p.status = 'active'
        AND ((c.service_date IS NOT NULL AND c.service_date >= ?) OR (c.service_date IS NULL AND p.end_date >= ?))
      GROUP BY c.meal`,
    [today, today],
  );

  const staffActivity = all<{ name: string; n: number }>(
    db,
    `SELECT s.full_name AS name, COUNT(*) AS n FROM claims c JOIN staff s ON s.id = c.staff_id
      WHERE c.status = 'confirmed' AND c.service_date BETWEEN ? AND ?
      GROUP BY s.id ORDER BY n DESC`,
    [from, to],
  ).map((r) => ({ staffName: r.name, claims: r.n }));

  const exceptions = one<{ awaiting: number; manual: number }>(
    db,
    `SELECT (SELECT COUNT(*) FROM payments WHERE status IN ('reported', 'recorded')) AS awaiting,
            (SELECT COUNT(*) FROM claims WHERE source = 'manual' AND service_date BETWEEN ? AND ?) AS manual`,
    [from, to],
  )!;

  return {
    from,
    to,
    generatedAt: ctx.clock().toISOString(),
    meals: { total: byMeal.lunch + byMeal.dinner, byMeal, byBuffet: [...byBuffet.values()], byDay: [...byDay.values()] },
    rejections,
    packages: { created: pk.created, activated: pk.activated, activatedListValueRwf: pk.value ?? 0, pendingPayment: pk.pending },
    payments: {
      reportedRwf: payTotal('reported'),
      recordedUnverifiedRwf: payTotal('recorded'),
      verifiedRwf: payTotal('verified'),
      reconciledRwf: payTotal('reconciled'),
      rejectedCount: pay.find((p) => p.status === 'rejected')?.n ?? 0,
    },
    activeStudentsToday: activeStudents,
    remainingCredits: {
      lunch: remaining.find((r) => r.meal === 'lunch')?.n ?? 0,
      dinner: remaining.find((r) => r.meal === 'dinner')?.n ?? 0,
    },
    staffActivity,
    pendingExceptions: {
      paymentsAwaitingVerification: exceptions.awaiting,
      packagesAwaitingPayment: pk.pending,
      manualClaims: exceptions.manual,
    },
  };
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formula injection and quote everything.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function claimsCsv(ctx: Ctx, from: string, to: string): string {
  const rows = all<Record<string, unknown>>(
    ctx.db,
    `SELECT c.service_date, c.meal, b.code AS buffet, s.student_number, s.full_name AS student_name,
            st.full_name AS staff_name, c.source, c.status, c.created_at AS recorded_at_utc,
            c.manual_reference, c.void_reason
       FROM claims c
       JOIN buffets b ON b.id = c.buffet_id
       JOIN students s ON s.id = c.student_id
       JOIN staff st ON st.id = c.staff_id
      WHERE c.service_date BETWEEN ? AND ?
      ORDER BY c.service_date, c.meal, c.created_at`,
    [from, to],
  );
  const header = [
    'service_date',
    'meal',
    'buffet',
    'student_number',
    'student_name',
    'staff_name',
    'source',
    'status',
    'recorded_at_utc',
    'manual_reference',
    'void_reason',
  ];
  return [header.join(','), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(','))].join('\r\n') + '\r\n';
}
