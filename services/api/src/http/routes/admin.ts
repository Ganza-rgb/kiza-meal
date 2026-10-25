import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context';
import { listAudit } from '../../domain/audit';
import {
  createScannerDevice,
  createStaff,
  listBuffets,
  listScannerDevices,
  listStaff,
  reissueEnrollment,
  revokeScannerDevice,
  updateStaff,
} from '../../domain/auth';
import { getClaimSummary, recordManualClaim, voidClaim } from '../../domain/claims';
import {
  activatePackage,
  cancelPackage,
  createPackage,
  createPackageType,
  listPackageTypes,
  updatePackageType,
} from '../../domain/packages';
import { createPayment, listPayments, transitionPayment } from '../../domain/payments';
import { claimsCsv, reportSummary } from '../../domain/reports';
import { addClosure, getMealWindows, listClosures, removeClosure, setMealWindows } from '../../domain/settings';
import {
  issueActivationCode,
  readStudentPhoto,
  registerStudent,
  revokeStudentDevices,
  saveStudentPhoto,
  scannerRecentlySaw,
  searchStudents,
  studentDetail,
  updateStudent,
} from '../../domain/students';
import { ApiError } from '../../errors';
import { addDays, kigaliDate } from '../../time';
import { MANAGER, OFFICE_ROLES, requireStaff } from '../auth';
import { parse, S } from '../validate';

export function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  const today = () => kigaliDate(ctx.clock());

  // ---------------- Students ----------------
  app.get('/students', async (req) => {
    requireStaff(req, OFFICE_ROLES);
    const { q } = parse(S.studentSearch, req.query);
    return { students: searchStudents(ctx, q, today()) };
  });

  app.post('/students', async (req, reply) => {
    const { actor } = requireStaff(req, OFFICE_ROLES);
    const body = parse(S.studentCreate, req.body);
    reply.code(201);
    return registerStudent(ctx, actor, body);
  });

  app.get('/students/:id', async (req) => {
    requireStaff(req, OFFICE_ROLES);
    const { id } = parse(S.idParam, req.params);
    return studentDetail(ctx, id, today());
  });

  app.patch('/students/:id', async (req) => {
    const { actor } = requireStaff(req, OFFICE_ROLES);
    const { id } = parse(S.idParam, req.params);
    return { student: updateStudent(ctx, actor, id, parse(S.studentUpdate, req.body)) };
  });

  app.post('/students/:id/photo', { bodyLimit: 3_000_000 }, async (req) => {
    const { actor } = requireStaff(req, OFFICE_ROLES);
    const { id } = parse(S.idParam, req.params);
    saveStudentPhoto(ctx, actor, id, parse(S.photo, req.body).imageBase64);
    return { ok: true };
  });

  /**
   * Photos are personal data. Office staff can view any; buffet staff only a student their own
   * scanner checked in the last 15 minutes (i.e. the person standing in front of them).
   */
  app.get('/students/:id/photo', async (req, reply) => {
    const auth = requireStaff(req);
    const { id } = parse(S.idParam, req.params);
    if (auth.actor.role === 'buffet_staff') {
      if (!auth.scanner || !scannerRecentlySaw(ctx, auth.scanner.id, id)) throw new ApiError('forbidden', 'Photo not available');
    }
    const photo = readStudentPhoto(ctx, id);
    if (!photo) throw new ApiError('not_found', 'No photo');
    return reply.header('cache-control', 'private, max-age=600').type(photo.mime).send(photo.data);
  });

  app.post('/students/:id/activation-code', async (req) => {
    const { actor } = requireStaff(req, OFFICE_ROLES);
    const { id } = parse(S.idParam, req.params);
    return issueActivationCode(ctx, actor, id);
  });

  app.post('/students/:id/revoke-devices', async (req) => {
    const { actor } = requireStaff(req, OFFICE_ROLES);
    const { id } = parse(S.idParam, req.params);
    const { reason } = parse(S.reason, req.body);
    return { revoked: revokeStudentDevices(ctx, actor, id, reason) };
  });

  // ---------------- Packages ----------------
  app.get('/package-types', async (req) => {
    const auth = requireStaff(req, OFFICE_ROLES);
    return { packageTypes: listPackageTypes(ctx, auth.actor.role === 'manager') };
  });

  app.post('/package-types', async (req, reply) => {
    const { actor } = requireStaff(req, MANAGER);
    reply.code(201);
    return { packageType: createPackageType(ctx, actor, parse(S.packageTypeCreate, req.body)) };
  });

  app.patch('/package-types/:id', async (req) => {
    const { actor } = requireStaff(req, MANAGER);
    const { id } = parse(S.idParam, req.params);
    return { packageType: updatePackageType(ctx, actor, id, parse(S.packageTypeUpdate, req.body)) };
  });

  app.post('/students/:id/packages', async (req, reply) => {
    const { actor } = requireStaff(req, OFFICE_ROLES);
    const { id } = parse(S.idParam, req.params);
    const body = parse(S.packageCreate, req.body);
    reply.code(201);
    return { package: createPackage(ctx, actor, id, body.packageTypeId, body.requestedStartDate) };
  });

  app.post('/packages/:id/activate', async (req) => {
    const { actor } = requireStaff(req, OFFICE_ROLES);
    const { id } = parse(S.idParam, req.params);
    return { package: activatePackage(ctx, actor, id) };
  });

  app.post('/packages/:id/cancel', async (req) => {
    const { actor } = requireStaff(req, MANAGER);
    const { id } = parse(S.idParam, req.params);
    return { package: cancelPackage(ctx, actor, id, parse(S.reason, req.body).reason) };
  });

  // ---------------- Payments ----------------
  app.get('/payments', async (req) => {
    requireStaff(req, OFFICE_ROLES);
    return { payments: listPayments(ctx, parse(S.paymentList, req.query)) };
  });

  app.post('/payments', async (req, reply) => {
    const { actor } = requireStaff(req, OFFICE_ROLES);
    reply.code(201);
    return { payment: createPayment(ctx, actor, parse(S.paymentCreate, req.body)) };
  });

  for (const action of ['record', 'verify', 'reconcile', 'reject'] as const) {
    app.post(`/payments/:id/${action}`, async (req) => {
      const { actor } = requireStaff(req, action === 'reconcile' ? MANAGER : OFFICE_ROLES);
      const { id } = parse(S.idParam, req.params);
      return { payment: transitionPayment(ctx, actor, id, action, parse(S.paymentTransition, req.body ?? {})) };
    });
  }

  // ---------------- Claims (exceptions) ----------------
  app.post('/claims/manual', async (req, reply) => {
    const { actor } = requireStaff(req, OFFICE_ROLES);
    reply.code(201);
    return { claim: recordManualClaim(ctx, actor, parse(S.manualClaim, req.body)) };
  });

  app.post('/claims/:id/void', async (req) => {
    const { actor } = requireStaff(req, MANAGER);
    const { id } = parse(S.idParam, req.params);
    return { claim: voidClaim(ctx, actor, id, parse(S.reason, req.body).reason) };
  });

  app.get('/claims/:id', async (req) => {
    requireStaff(req, OFFICE_ROLES);
    const { id } = parse(S.idParam, req.params);
    return { claim: getClaimSummary(ctx, id) };
  });

  // ---------------- Staff, buffets and scanner phones ----------------
  app.get('/buffets', async (req) => {
    requireStaff(req);
    return { buffets: listBuffets(ctx) };
  });

  app.get('/staff', async (req) => {
    requireStaff(req, MANAGER);
    return { staff: listStaff(ctx) };
  });

  app.post('/staff', async (req, reply) => {
    const { actor } = requireStaff(req, MANAGER);
    reply.code(201);
    return { staff: await createStaff(ctx, actor, parse(S.staffCreate, req.body)) };
  });

  app.patch('/staff/:id', async (req) => {
    const { actor } = requireStaff(req, MANAGER);
    const { id } = parse(S.idParam, req.params);
    return { staff: await updateStaff(ctx, actor, id, parse(S.staffUpdate, req.body)) };
  });

  app.get('/scanner-devices', async (req) => {
    requireStaff(req, MANAGER);
    return { devices: listScannerDevices(ctx) };
  });

  app.post('/scanner-devices', async (req, reply) => {
    const { actor } = requireStaff(req, MANAGER);
    const body = parse(S.scannerCreate, req.body);
    reply.code(201);
    return createScannerDevice(ctx, actor, body.buffetId, body.label);
  });

  app.post('/scanner-devices/:id/reissue', async (req) => {
    const { actor } = requireStaff(req, MANAGER);
    const { id } = parse(S.idParam, req.params);
    return reissueEnrollment(ctx, actor, id);
  });

  app.post('/scanner-devices/:id/revoke', async (req) => {
    const { actor } = requireStaff(req, MANAGER);
    const { id } = parse(S.idParam, req.params);
    revokeScannerDevice(ctx, actor, id);
    return { ok: true };
  });

  // ---------------- Reports & audit ----------------
  app.get('/reports/summary', async (req) => {
    requireStaff(req, MANAGER);
    const q = req.query as { from?: string; to?: string };
    const range = parse(S.dateRange, { from: q.from ?? today(), to: q.to ?? today() });
    return reportSummary(ctx, range.from, range.to);
  });

  app.get('/reports/claims.csv', async (req, reply) => {
    requireStaff(req, MANAGER);
    const q = req.query as { from?: string; to?: string };
    const range = parse(S.dateRange, { from: q.from ?? addDays(today(), -6), to: q.to ?? today() });
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="kiza-claims-${range.from}_${range.to}.csv"`)
      .send(claimsCsv(ctx, range.from, range.to));
  });

  app.get('/audit', async (req) => {
    requireStaff(req, MANAGER);
    const q = parse(S.audit, req.query);
    return { entries: listAudit(ctx, { limit: q.limit, beforeId: q.before, entityId: q.entityId }) };
  });

  // ---------------- Operating settings ----------------
  app.get('/settings/meal-windows', async (req) => {
    requireStaff(req);
    return { mealWindows: getMealWindows(ctx) };
  });

  app.put('/settings/meal-windows', async (req) => {
    const { actor } = requireStaff(req, MANAGER);
    return { mealWindows: setMealWindows(ctx, actor, parse(S.mealWindows, req.body)) };
  });

  app.get('/closures', async (req) => {
    requireStaff(req, OFFICE_ROLES);
    return { closures: listClosures(ctx, addDays(today(), -30)) };
  });

  app.post('/closures', async (req) => {
    const { actor } = requireStaff(req, MANAGER);
    const body = parse(S.closure, req.body);
    addClosure(ctx, actor, body.date, body.reason);
    return { ok: true };
  });

  app.delete('/closures/:date', async (req) => {
    const { actor } = requireStaff(req, MANAGER);
    removeClosure(ctx, actor, parse(S.closureParam, req.params).date);
    return { ok: true };
  });
}
