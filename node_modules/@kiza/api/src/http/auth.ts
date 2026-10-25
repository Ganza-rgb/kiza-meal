import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ScannerDeviceInfo, StaffRole } from '@kiza/shared';
import type { Actor, Ctx } from '../context';
import { one } from '../db/db';
import { getScannerDevice, resolveSession, type SessionInfo } from '../domain/auth';
import { ApiError } from '../errors';

export interface AuthContext {
  session: SessionInfo;
  actor: Actor;
  mustChangePassword: boolean;
  scanner: ScannerDeviceInfo | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export const DEVICE_HEADER = 'x-kiza-device';

export function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  const token = h.slice(7).trim();
  return token.length > 10 ? token : null;
}

export function makeAuthHook(ctx: Ctx) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    req.auth = null;
    const token = bearer(req);
    if (!token) return;
    const session = resolveSession(ctx, token);
    if (!session) return;

    if (session.subjectType === 'staff') {
      const staff = one<{ id: string; role: StaffRole; full_name: string; active: number; must_change_password: number }>(
        ctx.db,
        'SELECT id, role, full_name, active, must_change_password FROM staff WHERE id = ?',
        [session.subjectId],
      );
      if (!staff || staff.active !== 1) return;
      let scanner: ScannerDeviceInfo | null = null;
      if (session.scannerDeviceId) {
        const device = getScannerDevice(ctx, session.scannerDeviceId);
        if (!device || device.revoked) return; // revoked phone → session no longer valid
        scanner = { id: device.id, label: device.label, buffet: device.buffet };
      }
      req.auth = {
        session,
        actor: { type: 'staff', id: staff.id, role: staff.role, name: staff.full_name },
        mustChangePassword: staff.must_change_password === 1,
        scanner,
      };
    } else {
      const student = one<{ id: string; status: string }>(ctx.db, 'SELECT id, status FROM students WHERE id = ?', [session.subjectId]);
      if (!student) return;
      req.auth = { session, actor: { type: 'student', id: student.id }, mustChangePassword: false, scanner: null };
    }
  };
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new ApiError('unauthorized', 'Sign in required');
  return req.auth;
}

export function requireStaff(req: FastifyRequest, roles?: StaffRole[]): AuthContext & { actor: Actor & { type: 'staff' } } {
  const auth = requireAuth(req);
  if (auth.actor.type !== 'staff') throw new ApiError('forbidden', 'Staff only');
  if (auth.mustChangePassword) throw new ApiError('password_change_required', 'Change your temporary password first');
  if (roles && !roles.includes(auth.actor.role)) throw new ApiError('forbidden', 'Your role cannot do this');
  return auth as AuthContext & { actor: Actor & { type: 'staff' } };
}

export function requireStudent(req: FastifyRequest): AuthContext & { actor: Actor & { type: 'student' } } {
  const auth = requireAuth(req);
  if (auth.actor.type !== 'student') throw new ApiError('forbidden', 'Students only');
  return auth as AuthContext & { actor: Actor & { type: 'student' } };
}

export function requireScanner(req: FastifyRequest) {
  const auth = requireStaff(req);
  if (!auth.scanner) throw new ApiError('device_required', 'This session is not on an enrolled scanning phone');
  return { ...auth, scanner: auth.scanner };
}

export const OFFICE_ROLES: StaffRole[] = ['registrar', 'manager'];
export const MANAGER: StaffRole[] = ['manager'];
