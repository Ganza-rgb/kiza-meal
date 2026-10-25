export const MEAL_TYPES = ['lunch', 'dinner'] as const;
export type MealType = (typeof MEAL_TYPES)[number];

export const STAFF_ROLES = ['buffet_staff', 'registrar', 'manager'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const INSTITUTIONS = ['UR', 'RP', 'OTHER'] as const;
export type Institution = (typeof INSTITUTIONS)[number];

export const STUDENT_STATUSES = ['pending', 'active', 'suspended'] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

/**
 * calendar: credits are tied to consecutive operating dates (a missed day is lost).
 * flexible: N lunch + N dinner credits usable on any day within the validity window.
 */
export const PACKAGE_MODES = ['calendar', 'flexible'] as const;
export type PackageMode = (typeof PACKAGE_MODES)[number];

export const PACKAGE_STATUSES = ['pending_payment', 'active', 'cancelled'] as const;
export type PackageStatus = (typeof PACKAGE_STATUSES)[number];
/** Derived, display-only status (expiry and "not started" are computed from dates). */
export type PackageDisplayStatus = PackageStatus | 'scheduled' | 'expired';

export const PAYMENT_METHODS = ['momo', 'cash', 'bank', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * reported   – the student says they paid (no proof accepted yet)
 * recorded   – staff entered the payment details
 * verified   – staff checked it against the MoMo/bank statement or counted the cash
 * reconciled – a manager matched it in the end-of-day reconciliation
 * rejected   – could not be verified
 */
export const PAYMENT_STATUSES = ['reported', 'recorded', 'verified', 'reconciled', 'rejected'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Outcomes of a scan. Every code must have a staff-facing translation in the app. */
export const REJECTION_CODES = [
  'invalid_qr',
  'expired_qr',
  'revoked_credential',
  'unknown_student',
  'student_suspended',
  'registration_pending',
  'no_active_package',
  'package_not_started',
  'package_expired',
  'payment_pending',
  'meal_not_included',
  'no_entitlement',
  'duplicate_claim',
  'outside_service_hours',
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

/** API error codes returned as `{ error: { code, message } }`. */
export const API_ERROR_CODES = [
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'invalid_credentials',
  'account_locked',
  'account_inactive',
  'activation_invalid',
  'device_required',
  'device_revoked',
  'enrollment_invalid',
  'password_change_required',
  'duplicate_student_number',
  'duplicate_phone',
  'duplicate_payment_reference',
  'payment_insufficient',
  'invalid_state',
  'rate_limited',
  'internal_error',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
