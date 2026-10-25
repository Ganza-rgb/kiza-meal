import type {
  ApiErrorCode,
  Institution,
  MealType,
  PackageDisplayStatus,
  PackageMode,
  PaymentMethod,
  PaymentStatus,
  RejectionCode,
  StaffRole,
  StudentStatus,
} from './codes';

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}

export interface HealthResponse {
  ok: true;
  service: 'kiza-api';
  version: string;
  serverTime: string;
  localDate: string;
  currentMeal: MealType | null;
}

export interface MealWindow {
  start: string; // "HH:MM" Africa/Kigali
  end: string;
}
export type MealWindows = Record<MealType, MealWindow>;

// ---------- Auth ----------

export interface StaffProfile {
  id: string;
  username: string;
  fullName: string;
  role: StaffRole;
  mustChangePassword: boolean;
}

export interface BuffetInfo {
  id: string;
  code: string;
  name: string;
}

export interface ScannerDeviceInfo {
  id: string;
  label: string;
  buffet: BuffetInfo;
}

export interface StaffLoginResponse {
  token: string;
  expiresAt: string;
  staff: StaffProfile;
  device: ScannerDeviceInfo | null;
}

export interface StudentProfile {
  id: string;
  studentNumber: string;
  fullName: string;
  institution: Institution;
  status: StudentStatus;
  hasPhoto: boolean;
}

export interface StudentLoginResponse {
  token: string;
  expiresAt: string;
  student: StudentProfile;
}

export interface StudentDeviceResponse {
  deviceId: string;
  serverTime: string;
}

export interface EnrollResponse {
  deviceToken: string;
  device: ScannerDeviceInfo;
}

// ---------- Student-facing ----------

export interface PackageSummary {
  id: string;
  name: string;
  mode: PackageMode;
  status: PackageDisplayStatus;
  mealDays: number;
  includesLunch: boolean;
  includesDinner: boolean;
  priceRwf: number;
  startDate: string | null;
  endDate: string | null;
  requestedStartDate: string;
  remaining: { lunch: number; dinner: number };
  used: { lunch: number; dinner: number };
  paidVerifiedRwf: number;
}

export interface ClaimSummary {
  id: string;
  serviceDate: string;
  meal: MealType;
  buffetName: string;
  confirmedAt: string;
  status: 'confirmed' | 'voided';
  source: 'scan' | 'manual';
}

export interface PaymentSummary {
  id: string;
  packageId: string | null;
  amountRwf: number;
  method: PaymentMethod;
  reference: string | null;
  status: PaymentStatus;
  recordedAt: string;
}

export interface TodayStatus {
  date: string;
  currentMeal: MealType | null;
  lunch: 'claimed' | 'available' | 'not_entitled';
  dinner: 'claimed' | 'available' | 'not_entitled';
}

export interface StudentSummaryResponse {
  student: StudentProfile;
  today: TodayStatus;
  activePackage: PackageSummary | null;
  packages: PackageSummary[];
  recentClaims: ClaimSummary[];
  payments: PaymentSummary[];
  serverTime: string;
}

// ---------- Scanning ----------

export interface ScanStudent {
  id: string;
  fullName: string;
  studentNumber: string;
  institution: Institution;
  hasPhoto: boolean;
}

export interface ScanAccepted {
  outcome: 'accepted';
  idempotencyKey: string;
  claimId: string;
  student: ScanStudent;
  meal: MealType;
  serviceDate: string;
  confirmedAt: string;
  buffet: BuffetInfo;
  remainingForMeal: number;
  /** true when this response replays an earlier result for the same idempotency key. */
  replayed: boolean;
}

export interface ScanRejected {
  outcome: 'rejected';
  idempotencyKey: string;
  code: RejectionCode;
  student: ScanStudent | null;
  meal: MealType | null;
  serviceDate: string;
  /** For duplicate_claim: when and where the original claim happened. */
  previousClaim?: { confirmedAt: string; buffetName: string };
  replayed: boolean;
}

export type ScanResponse = ScanAccepted | ScanRejected;

export interface ScanRequest {
  idempotencyKey: string;
  qr: string;
}

// ---------- Staff-facing ----------

export interface StudentListItem {
  id: string;
  studentNumber: string;
  fullName: string;
  institution: Institution;
  status: StudentStatus;
  phone: string | null;
  hasPhoto: boolean;
  activePackageName: string | null;
}

export interface StudentDetailResponse {
  student: StudentListItem & {
    accountActivated: boolean;
    activationCodeExpiresAt: string | null;
    createdAt: string;
  };
  packages: PackageSummary[];
  payments: PaymentSummary[];
  claims: ClaimSummary[];
  devices: { id: string; label: string | null; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }[];
}

export interface PackageType {
  id: string;
  name: string;
  mode: PackageMode;
  mealDays: number;
  validityDays: number;
  priceRwf: number;
  includesLunch: boolean;
  includesDinner: boolean;
  active: boolean;
  notes: string | null;
}

export interface PaymentListItem extends PaymentSummary {
  studentId: string;
  studentName: string;
  studentNumber: string;
  packageName: string | null;
  recordedByName: string | null;
  verifiedByName: string | null;
  notes: string | null;
}

export interface ReportSummary {
  from: string;
  to: string;
  generatedAt: string;
  meals: {
    total: number;
    byMeal: Record<MealType, number>;
    byBuffet: { buffetCode: string; buffetName: string; lunch: number; dinner: number }[];
    byDay: { date: string; lunch: number; dinner: number }[];
  };
  rejections: { code: RejectionCode; count: number }[];
  packages: {
    created: number;
    activated: number;
    /** Sum of list prices of packages activated in range — an estimate, not verified revenue. */
    activatedListValueRwf: number;
    pendingPayment: number;
  };
  payments: {
    reportedRwf: number;
    recordedUnverifiedRwf: number;
    verifiedRwf: number;
    reconciledRwf: number;
    rejectedCount: number;
  };
  activeStudentsToday: number;
  remainingCredits: { lunch: number; dinner: number };
  staffActivity: { staffName: string; claims: number }[];
  pendingExceptions: { paymentsAwaitingVerification: number; packagesAwaitingPayment: number; manualClaims: number };
}

export interface AuditEntry {
  id: number;
  at: string;
  actorType: string;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  details: unknown;
}
