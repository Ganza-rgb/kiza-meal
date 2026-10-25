import type { FastifyInstance } from 'fastify';
import type { StudentSummaryResponse, TodayStatus } from '@kiza/shared';
import type { Ctx } from '../../context';
import { one } from '../../db/db';
import { registerStudentDevice, studentDeviceStatus } from '../../domain/auth';
import { studentClaims } from '../../domain/claims';
import { studentPackages } from '../../domain/packages';
import { createPayment, studentPayments } from '../../domain/payments';
import { currentService } from '../../domain/settings';
import { getStudentRow, readStudentPhoto, toStudentProfile } from '../../domain/students';
import { ApiError } from '../../errors';
import { requireStudent } from '../auth';
import { parse, S } from '../validate';

export function studentRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/student/summary', async (req): Promise<StudentSummaryResponse> => {
    const { actor } = requireStudent(req);
    const student = getStudentRow(ctx, actor.id);
    const packages = studentPackages(ctx, student.id);
    const svc = currentService(ctx);

    const mealState = (meal: 'lunch' | 'dinner'): TodayStatus['lunch'] => {
      const claimed = one(ctx.db, `SELECT 1 AS x FROM claims WHERE student_id = ? AND service_date = ? AND meal = ? AND status = 'confirmed'`, [
        student.id,
        svc.date,
        meal,
      ]);
      if (claimed) return 'claimed';
      const available = one(
        ctx.db,
        `SELECT 1 AS x FROM meal_credits c JOIN packages p ON p.id = c.package_id
          WHERE c.student_id = ? AND c.meal = ? AND c.status = 'available' AND p.status = 'active'
            AND (c.service_date = ? OR (c.service_date IS NULL AND p.start_date <= ? AND p.end_date >= ?))
          LIMIT 1`,
        [student.id, meal, svc.date, svc.date, svc.date],
      );
      return available ? 'available' : 'not_entitled';
    };

    return {
      student: toStudentProfile(student),
      today: { date: svc.date, currentMeal: svc.meal, lunch: mealState('lunch'), dinner: mealState('dinner') },
      activePackage: packages.find((p) => p.status === 'active') ?? packages.find((p) => p.status === 'scheduled') ?? null,
      packages,
      recentClaims: studentClaims(ctx, student.id, 10),
      payments: studentPayments(ctx, student.id),
      serverTime: ctx.clock().toISOString(),
    };
  });

  app.get('/student/claims', async (req) => {
    const { actor } = requireStudent(req);
    const { limit } = parse(S.limit, req.query);
    return { claims: studentClaims(ctx, actor.id, limit) };
  });

  app.get('/student/photo', async (req, reply) => {
    const { actor } = requireStudent(req);
    const photo = readStudentPhoto(ctx, actor.id);
    if (!photo) throw new ApiError('not_found', 'No photo');
    return reply.header('cache-control', 'private, max-age=300').type(photo.mime).send(photo.data);
  });

  /** Register this phone's public key; the private key never leaves the phone. */
  app.post('/student/device', async (req) => {
    const { actor } = requireStudent(req);
    const body = parse(S.studentDevice, req.body);
    return registerStudentDevice(ctx, actor.id, body.publicKey, body.label ?? null);
  });

  app.get('/student/device/:id', async (req) => {
    const { actor } = requireStudent(req);
    const { id } = parse(S.idParam, req.params);
    return { status: studentDeviceStatus(ctx, actor.id, id), serverTime: ctx.clock().toISOString() };
  });

  /** Student says "I paid". This never activates anything; staff must verify it. */
  app.post('/student/payments/report', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req) => {
    const { actor } = requireStudent(req);
    const body = parse(S.studentPaymentReport, req.body);
    return createPayment(ctx, actor, { ...body, studentId: actor.id, notes: null });
  });
}
