// Ordered, append-only schema migrations. Never edit a migration that has shipped; add a new one.
// SQL is kept close to standard so a later move to PostgreSQL is mostly mechanical
// (TEXT ids, ISO timestamps, partial unique indexes, CHECK constraints).

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE buffets (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE staff (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('buffet_staff', 'registrar', 'manager')),
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE students (
  id TEXT PRIMARY KEY,
  student_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  phone TEXT,
  institution TEXT NOT NULL CHECK (institution IN ('UR', 'RP', 'OTHER')),
  photo_file TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  password_hash TEXT,
  activation_code_hash TEXT,
  activation_expires_at TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_by TEXT NOT NULL REFERENCES staff(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX students_phone_unique ON students(phone) WHERE phone IS NOT NULL;
CREATE INDEX students_full_name ON students(full_name COLLATE NOCASE);

-- The student's phone holds the private key; the server only knows the public key.
CREATE TABLE student_devices (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  public_key TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE INDEX student_devices_student ON student_devices(student_id);
-- At most one active pass device per student.
CREATE UNIQUE INDEX student_devices_one_active ON student_devices(student_id) WHERE revoked_at IS NULL;

CREATE TABLE scanner_devices (
  id TEXT PRIMARY KEY,
  buffet_id TEXT NOT NULL REFERENCES buffets(id),
  label TEXT NOT NULL,
  enrollment_code_hash TEXT,
  enrollment_expires_at TEXT,
  token_hash TEXT UNIQUE,
  enrolled_at TEXT,
  last_seen_at TEXT,
  revoked_at TEXT,
  created_by TEXT NOT NULL REFERENCES staff(id),
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('staff', 'student')),
  subject_id TEXT NOT NULL,
  scanner_device_id TEXT REFERENCES scanner_devices(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);
CREATE INDEX sessions_subject ON sessions(subject_type, subject_id);

CREATE TABLE package_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('calendar', 'flexible')),
  meal_days INTEGER NOT NULL CHECK (meal_days BETWEEN 1 AND 366),
  validity_days INTEGER NOT NULL CHECK (validity_days BETWEEN 1 AND 732),
  price_rwf INTEGER NOT NULL CHECK (price_rwf >= 0),
  includes_lunch INTEGER NOT NULL CHECK (includes_lunch IN (0, 1)),
  includes_dinner INTEGER NOT NULL CHECK (includes_dinner IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  notes TEXT,
  created_by TEXT NOT NULL REFERENCES staff(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (includes_lunch = 1 OR includes_dinner = 1)
);

-- A package snapshots its type's terms at sale time, so later price changes don't rewrite history.
CREATE TABLE packages (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  package_type_id TEXT NOT NULL REFERENCES package_types(id),
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('calendar', 'flexible')),
  meal_days INTEGER NOT NULL,
  validity_days INTEGER NOT NULL,
  price_rwf INTEGER NOT NULL,
  includes_lunch INTEGER NOT NULL,
  includes_dinner INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_payment', 'active', 'cancelled')),
  requested_start_date TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  created_by TEXT NOT NULL REFERENCES staff(id),
  created_at TEXT NOT NULL,
  activated_by TEXT REFERENCES staff(id),
  activated_at TEXT,
  cancelled_by TEXT REFERENCES staff(id),
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE INDEX packages_student ON packages(student_id, status);

-- One row per meal a package entitles the student to.
-- calendar packages: service_date fixed at activation. flexible: service_date set when claimed.
CREATE TABLE meal_credits (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  meal TEXT NOT NULL CHECK (meal IN ('lunch', 'dinner')),
  service_date TEXT,
  status TEXT NOT NULL CHECK (status IN ('available', 'claimed', 'void')),
  claim_id TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX meal_credits_lookup ON meal_credits(student_id, meal, status, service_date);
CREATE UNIQUE INDEX meal_credits_one_per_slot
  ON meal_credits(student_id, service_date, meal)
  WHERE service_date IS NOT NULL AND status <> 'void';

CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  credit_id TEXT NOT NULL REFERENCES meal_credits(id),
  package_id TEXT NOT NULL REFERENCES packages(id),
  service_date TEXT NOT NULL,
  meal TEXT NOT NULL CHECK (meal IN ('lunch', 'dinner')),
  buffet_id TEXT NOT NULL REFERENCES buffets(id),
  scanner_device_id TEXT REFERENCES scanner_devices(id),
  staff_id TEXT NOT NULL REFERENCES staff(id),
  source TEXT NOT NULL CHECK (source IN ('scan', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'voided')),
  idempotency_key TEXT UNIQUE,
  manual_reference TEXT,
  manual_reason TEXT,
  created_at TEXT NOT NULL,
  voided_by TEXT REFERENCES staff(id),
  voided_at TEXT,
  void_reason TEXT
);
-- THE duplicate guard: one confirmed lunch and one confirmed dinner per student per operating date.
CREATE UNIQUE INDEX claims_one_per_meal_session
  ON claims(student_id, service_date, meal)
  WHERE status = 'confirmed';
CREATE INDEX claims_date ON claims(service_date, buffet_id);

-- Every scan (accepted or rejected) with the exact response, keyed by the scanner's idempotency key.
CREATE TABLE scan_attempts (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  buffet_id TEXT NOT NULL REFERENCES buffets(id),
  scanner_device_id TEXT NOT NULL REFERENCES scanner_devices(id),
  staff_id TEXT NOT NULL REFERENCES staff(id),
  student_id TEXT,
  service_date TEXT NOT NULL,
  meal TEXT,
  outcome TEXT NOT NULL,
  claim_id TEXT,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX scan_attempts_date ON scan_attempts(service_date, outcome);
CREATE INDEX scan_attempts_device ON scan_attempts(scanner_device_id, created_at);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  package_id TEXT REFERENCES packages(id),
  amount_rwf INTEGER NOT NULL CHECK (amount_rwf > 0),
  currency TEXT NOT NULL DEFAULT 'RWF',
  method TEXT NOT NULL CHECK (method IN ('momo', 'cash', 'bank', 'other')),
  reference TEXT,
  status TEXT NOT NULL CHECK (status IN ('reported', 'recorded', 'verified', 'reconciled', 'rejected')),
  notes TEXT,
  reported_by_student INTEGER NOT NULL DEFAULT 0,
  recorded_by TEXT REFERENCES staff(id),
  recorded_at TEXT NOT NULL,
  verified_by TEXT REFERENCES staff(id),
  verified_at TEXT,
  reconciled_by TEXT REFERENCES staff(id),
  reconciled_at TEXT,
  rejected_by TEXT REFERENCES staff(id),
  rejected_at TEXT,
  reject_reason TEXT
);
CREATE INDEX payments_student ON payments(student_id);
CREATE INDEX payments_status ON payments(status, recorded_at);
CREATE UNIQUE INDEX payments_reference_unique
  ON payments(method, reference)
  WHERE reference IS NOT NULL AND status <> 'rejected';

CREATE TABLE closures (
  service_date TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES staff(id),
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('staff', 'student', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details TEXT
);
CREATE INDEX audit_log_entity ON audit_log(entity_type, entity_id);
`,
  },
];
