import type { MealType, MealWindows } from '@kiza/shared';
import type { Actor, Ctx } from '../context';
import { all, one, run, transaction } from '../db/db';
import { invalidState } from '../errors';
import { kigaliParts, parseHhMm } from '../time';
import { audit } from './audit';

/**
 * Default serving windows (Africa/Kigali). These are an operating ASSUMPTION — confirm the real
 * hours with Kiza management and change them in the app (Manager → Settings).
 */
export const DEFAULT_MEAL_WINDOWS: MealWindows = {
  lunch: { start: '11:00', end: '15:00' },
  dinner: { start: '17:00', end: '21:30' },
};

const MEAL_WINDOWS_KEY = 'meal_windows';

export function getMealWindows(ctx: Ctx): MealWindows {
  const row = one<{ value: string }>(ctx.db, 'SELECT value FROM settings WHERE key = ?', [MEAL_WINDOWS_KEY]);
  return row ? (JSON.parse(row.value) as MealWindows) : DEFAULT_MEAL_WINDOWS;
}

export function validateMealWindows(w: MealWindows): void {
  const l0 = parseHhMm(w.lunch.start);
  const l1 = parseHhMm(w.lunch.end);
  const d0 = parseHhMm(w.dinner.start);
  const d1 = parseHhMm(w.dinner.end);
  if (!(l0 < l1)) throw invalidState('Lunch must end after it starts');
  if (!(d0 < d1)) throw invalidState('Dinner must end after it starts');
  if (!(l1 <= d0)) throw invalidState('Lunch must end before dinner starts');
}

export function setMealWindows(ctx: Ctx, actor: Actor, windows: MealWindows): MealWindows {
  validateMealWindows(windows);
  transaction(ctx.db, () => {
    run(
      ctx.db,
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [MEAL_WINDOWS_KEY, JSON.stringify(windows), actor.id, ctx.clock().toISOString()],
    );
    audit(ctx, actor, 'settings.meal_windows.update', 'settings', MEAL_WINDOWS_KEY, { windows });
  });
  return windows;
}

export function mealAt(windows: MealWindows, minutes: number): MealType | null {
  for (const meal of ['lunch', 'dinner'] as const) {
    const w = windows[meal];
    if (minutes >= parseHhMm(w.start) && minutes < parseHhMm(w.end)) return meal;
  }
  return null;
}

/** The authoritative "which meal is being served right now" — always decided on the server. */
export function currentService(ctx: Ctx): { date: string; meal: MealType | null } {
  const { date, minutes } = kigaliParts(ctx.clock());
  return { date, meal: mealAt(getMealWindows(ctx), minutes) };
}

// ---- Closures (days the restaurant does not serve; calendar packages skip them) ----

export function listClosures(ctx: Ctx, fromDate: string): { date: string; reason: string }[] {
  return all<{ service_date: string; reason: string }>(
    ctx.db,
    'SELECT service_date, reason FROM closures WHERE service_date >= ? ORDER BY service_date',
    [fromDate],
  ).map((r) => ({ date: r.service_date, reason: r.reason }));
}

export function closureSet(ctx: Ctx, fromDate: string): Set<string> {
  return new Set(listClosures(ctx, fromDate).map((c) => c.date));
}

export function addClosure(ctx: Ctx, actor: Actor, date: string, reason: string): void {
  transaction(ctx.db, () => {
    run(
      ctx.db,
      `INSERT INTO closures (service_date, reason, created_by, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(service_date) DO UPDATE SET reason = excluded.reason`,
      [date, reason, actor.id, ctx.clock().toISOString()],
    );
    audit(ctx, actor, 'closure.add', 'closure', date, { reason });
  });
}

export function removeClosure(ctx: Ctx, actor: Actor, date: string): void {
  transaction(ctx.db, () => {
    run(ctx.db, 'DELETE FROM closures WHERE service_date = ?', [date]);
    audit(ctx, actor, 'closure.remove', 'closure', date);
  });
}
