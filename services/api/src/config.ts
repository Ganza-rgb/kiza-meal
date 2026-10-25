import { existsSync } from 'node:fs';
import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  photosDir: string;
  backupDir: string;
  backupIntervalHours: number;
  backupKeep: number;
  qrMaxAgeSeconds: number;
  staffSessionHours: number;
  studentSessionDays: number;
  devTools: boolean;
  production: boolean;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

export function loadConfig(): Config {
  const envFile = path.resolve(process.cwd(), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const production = process.env.NODE_ENV === 'production';
  const dataDir = path.resolve(process.env.KIZA_DATA_DIR || './data');
  const devTools = process.env.KIZA_DEV_TOOLS === '1';
  if (production && devTools) {
    throw new Error('KIZA_DEV_TOOLS must not be enabled when NODE_ENV=production');
  }

  return {
    host: process.env.KIZA_HOST || '0.0.0.0',
    port: num('KIZA_PORT', 4000),
    dataDir,
    dbPath: path.join(dataDir, 'kiza.db'),
    photosDir: path.join(dataDir, 'photos'),
    backupDir: path.resolve(process.env.KIZA_BACKUP_DIR || './backups'),
    backupIntervalHours: num('KIZA_BACKUP_INTERVAL_HOURS', 6),
    backupKeep: num('KIZA_BACKUP_KEEP', 30),
    qrMaxAgeSeconds: num('KIZA_QR_MAX_AGE_SECONDS', 90),
    staffSessionHours: num('KIZA_STAFF_SESSION_HOURS', 14),
    studentSessionDays: num('KIZA_STUDENT_SESSION_DAYS', 60),
    devTools,
    production,
  };
}
