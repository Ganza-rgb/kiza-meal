import type { StaffRole } from '@kiza/shared';
import type { Config } from './config';
import type { Db } from './db/db';
import type { Clock } from './time';

export interface Ctx {
  db: Db;
  config: Config;
  clock: Clock;
}

export type Actor =
  | { type: 'staff'; id: string; role: StaffRole; name: string }
  | { type: 'student'; id: string }
  | { type: 'system'; id: null };

export const SYSTEM: Actor = { type: 'system', id: null };

export const newId = (): string => crypto.randomUUID();
export const nowIso = (ctx: Ctx): string => ctx.clock().toISOString();
