// All operating dates are Rwanda local dates (Africa/Kigali, UTC+2, no DST).
// Timestamps are stored as UTC ISO-8601 strings.

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export const KIGALI_TZ = 'Africa/Kigali';

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: KIGALI_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export interface LocalParts {
  date: string; // YYYY-MM-DD
  minutes: number; // minutes since local midnight
}

export function kigaliParts(at: Date): LocalParts {
  const p = Object.fromEntries(partsFormatter.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

export function kigaliDate(at: Date): string {
  return kigaliParts(at).date;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Calendar arithmetic on YYYY-MM-DD strings (timezone-free). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function maxDate(...dates: string[]): string {
  return dates.reduce((a, b) => (a > b ? a : b));
}

/** UTC instant at which a Kigali local date begins (Kigali is a fixed UTC+2). */
export function kigaliDayStartUtc(date: string): string {
  return new Date(`${date}T00:00:00+02:00`).toISOString();
}

export function parseHhMm(value: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) throw new Error(`Invalid time "${value}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}
