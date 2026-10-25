import { z } from 'zod';
import { INSTITUTIONS, MEAL_TYPES, PACKAGE_MODES, PAYMENT_METHODS, PAYMENT_STATUSES, STAFF_ROLES, STUDENT_STATUSES } from '@kiza/shared';
import { ApiError } from '../errors';
import { isIsoDate } from '../time';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiError(
      'validation_failed',
      'Some fields are missing or invalid',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

const text = (max: number) => z.string().trim().min(1).max(max);
export const isoDate = z.string().refine(isIsoDate, 'Expected a date YYYY-MM-DD');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');
const uuid = z.string().uuid();

export const S = {
  idParam: z.object({ id: z.string().min(1).max(64) }),
  staffLogin: z.object({ username: text(64), password: z.string().min(1).max(200) }),
  studentLogin: z.object({ studentNumber: text(40), password: z.string().min(1).max(200) }),
  studentActivate: z.object({ studentNumber: text(40), activationCode: text(20), password: z.string().min(8).max(200) }),
  changePassword: z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(8).max(200) }),
  enroll: z.object({ enrollmentCode: text(20) }),
  studentDevice: z.object({ publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/), label: z.string().trim().max(60).nullish() }),
  scan: z.object({ idempotencyKey: uuid, qr: z.string().min(1).max(500) }),
  scanKey: z.object({ key: uuid }),

  studentCreate: z.object({
    studentNumber: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9/_.-]+$/, 'Letters, digits and / _ . - only'),
    fullName: text(120),
    phone: z.string().trim().max(20).nullish(),
    institution: z.enum(INSTITUTIONS),
  }),
  studentUpdate: z.object({
    fullName: text(120).optional(),
    phone: z.string().trim().max(20).nullable().optional(),
    institution: z.enum(INSTITUTIONS).optional(),
    status: z.enum(STUDENT_STATUSES).optional(),
    reason: z.string().trim().max(300).optional(),
  }),
  studentSearch: z.object({ q: z.string().max(80).default('') }),
  photo: z.object({ imageBase64: z.string().min(100).max(2_200_000) }),
  reason: z.object({ reason: text(300) }),

  packageTypeCreate: z.object({
    name: text(80),
    mode: z.enum(PACKAGE_MODES),
    mealDays: z.number().int().min(1).max(366),
    validityDays: z.number().int().min(1).max(732).optional(),
    priceRwf: z.number().int().min(0).max(10_000_000),
    includesLunch: z.boolean(),
    includesDinner: z.boolean(),
    notes: z.string().trim().max(300).nullish(),
  }),
  packageTypeUpdate: z.object({
    name: text(80).optional(),
    priceRwf: z.number().int().min(0).max(10_000_000).optional(),
    notes: z.string().trim().max(300).nullable().optional(),
    active: z.boolean().optional(),
  }),
  packageCreate: z.object({ packageTypeId: uuid, requestedStartDate: isoDate.optional() }),

  paymentCreate: z.object({
    studentId: uuid,
    packageId: uuid.nullish(),
    amountRwf: z.number().int().min(1).max(10_000_000),
    method: z.enum(PAYMENT_METHODS),
    reference: z.string().trim().max(60).nullish(),
    notes: z.string().trim().max(300).nullish(),
  }),
  studentPaymentReport: z.object({
    packageId: uuid.nullish(),
    amountRwf: z.number().int().min(1).max(10_000_000),
    method: z.enum(PAYMENT_METHODS),
    reference: z.string().trim().max(60).nullish(),
  }),
  paymentTransition: z.object({
    reason: z.string().trim().max(300).optional(),
    packageId: uuid.nullable().optional(),
    amountRwf: z.number().int().min(1).max(10_000_000).optional(),
    reference: z.string().trim().max(60).nullable().optional(),
  }),
  paymentList: z.object({
    status: z.enum(PAYMENT_STATUSES).optional(),
    studentId: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),

  manualClaim: z.object({
    studentId: uuid,
    serviceDate: isoDate,
    meal: z.enum(MEAL_TYPES),
    buffetId: uuid,
    reference: text(60),
    reason: text(300),
  }),

  staffCreate: z.object({
    username: z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9._-]+$/),
    fullName: text(120),
    role: z.enum(STAFF_ROLES),
    password: z.string().min(8).max(200),
  }),
  staffUpdate: z.object({
    fullName: text(120).optional(),
    role: z.enum(STAFF_ROLES).optional(),
    active: z.boolean().optional(),
    password: z.string().min(8).max(200).optional(),
  }),
  scannerCreate: z.object({ buffetId: uuid, label: text(60) }),

  dateRange: z
    .object({ from: isoDate, to: isoDate })
    .refine((v) => v.from <= v.to, 'from must be before to')
    .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86400_000 <= 400, 'Range too long'),
  audit: z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.coerce.number().int().optional(),
    entityId: z.string().max(64).optional(),
  }),
  mealWindows: z.object({
    lunch: z.object({ start: hhmm, end: hhmm }),
    dinner: z.object({ start: hhmm, end: hhmm }),
  }),
  closure: z.object({ date: isoDate, reason: text(200) }),
  closureParam: z.object({ date: isoDate }),
  limit: z.object({ limit: z.coerce.number().int().min(1).max(200).default(30) }),
};
