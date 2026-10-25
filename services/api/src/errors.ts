import type { ApiErrorCode } from '@kiza/shared';

const STATUS: Partial<Record<ApiErrorCode, number>> = {
  validation_failed: 400,
  unauthorized: 401,
  invalid_credentials: 401,
  activation_invalid: 401,
  enrollment_invalid: 401,
  device_required: 401,
  device_revoked: 401,
  forbidden: 403,
  account_inactive: 403,
  password_change_required: 403,
  not_found: 404,
  conflict: 409,
  duplicate_student_number: 409,
  duplicate_phone: 409,
  duplicate_payment_reference: 409,
  invalid_state: 409,
  payment_insufficient: 409,
  account_locked: 423,
  rate_limited: 429,
  internal_error: 500,
};

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = STATUS[code] ?? 400;
  }
}

export const notFound = (what: string) => new ApiError('not_found', `${what} not found`);
export const invalidState = (message: string, details?: unknown) => new ApiError('invalid_state', message, details);
