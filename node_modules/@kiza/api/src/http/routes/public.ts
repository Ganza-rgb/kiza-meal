import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@kiza/shared';
import type { Ctx } from '../../context';
import {
  activateStudentAccount,
  changeStaffPassword,
  enrollScannerDevice,
  getStaffRow,
  loginStaff,
  loginStudent,
  resolveScannerDevice,
  revokeSession,
  toStaffProfile,
} from '../../domain/auth';
import { currentService } from '../../domain/settings';
import { getStudentRow, toStudentProfile } from '../../domain/students';
import { ApiError } from '../../errors';
import { DEVICE_HEADER, requireAuth } from '../auth';
import { parse, S } from '../validate';

export const VERSION = '0.1.0';

const loginLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export function publicRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/health', async (): Promise<HealthResponse> => {
    const svc = currentService(ctx);
    return {
      ok: true,
      service: 'kiza-api',
      version: VERSION,
      serverTime: ctx.clock().toISOString(),
      localDate: svc.date,
      currentMeal: svc.meal,
    };
  });

  app.post('/auth/staff/login', { config: loginLimit }, async (req) => {
    const body = parse(S.staffLogin, req.body);
    const deviceToken = (req.headers[DEVICE_HEADER] as string | undefined) ?? null;
    return loginStaff(ctx, body.username, body.password, deviceToken);
  });

  app.post('/auth/student/login', { config: loginLimit }, async (req) => {
    const body = parse(S.studentLogin, req.body);
    return loginStudent(ctx, body.studentNumber, body.password);
  });

  app.post('/auth/student/activate', { config: loginLimit }, async (req) => {
    const body = parse(S.studentActivate, req.body);
    return activateStudentAccount(ctx, body.studentNumber, body.activationCode, body.password);
  });

  app.post('/auth/logout', async (req) => {
    const auth = requireAuth(req);
    revokeSession(ctx, auth.session.sessionId);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const auth = requireAuth(req);
    if (auth.actor.type === 'staff') {
      return { type: 'staff' as const, staff: toStaffProfile(getStaffRow(ctx, auth.actor.id)!), device: auth.scanner };
    }
    return { type: 'student' as const, student: toStudentProfile(getStudentRow(ctx, auth.actor.id!)) };
  });

  app.post('/auth/change-password', { config: loginLimit }, async (req) => {
    const auth = requireAuth(req);
    if (auth.actor.type !== 'staff') throw new ApiError('forbidden', 'Students reset their password with an activation code');
    const body = parse(S.changePassword, req.body);
    await changeStaffPassword(ctx, auth.actor.id, body.currentPassword, body.newPassword);
    return { ok: true };
  });

  // ---- Scanner phone enrolment ----
  app.post('/scanner/enroll', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(S.enroll, req.body);
    return enrollScannerDevice(ctx, body.enrollmentCode);
  });

  /** Lets an enrolled phone check whether it is still authorised (before anyone signs in). */
  app.get('/scanner/device', async (req) => {
    const token = req.headers[DEVICE_HEADER] as string | undefined;
    const device = token ? resolveScannerDevice(ctx, token) : null;
    if (!device) throw new ApiError('device_revoked', 'This scanning phone is not authorised');
    return { device };
  });
}
