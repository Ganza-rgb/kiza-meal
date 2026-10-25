import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context';
import { touchScannerDevice } from '../../domain/auth';
import { lookupScan, processScan, recentScans } from '../../domain/claims';
import { currentService } from '../../domain/settings';
import { ApiError } from '../../errors';
import { requireScanner } from '../auth';
import { parse, S } from '../validate';

export function scanRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/scan', async (req) => {
    const { actor, scanner } = requireScanner(req);
    const body = parse(S.scan, req.body);
    touchScannerDevice(ctx, scanner.id);
    return processScan(ctx, { deviceId: scanner.id, buffet: scanner.buffet, staffId: actor.id }, body.idempotencyKey, body.qr);
  });

  /** Outcome lookup for a request whose response was lost (timeout, Wi-Fi drop, app restart). */
  app.get('/scan/:key', async (req) => {
    const { scanner } = requireScanner(req);
    const { key } = parse(S.scanKey, req.params);
    const result = lookupScan(ctx, scanner.id, key);
    if (!result) throw new ApiError('not_found', 'No scan with this key was received');
    return result;
  });

  app.get('/scanner/status', async (req) => {
    const { actor, scanner } = requireScanner(req);
    touchScannerDevice(ctx, scanner.id);
    return { device: scanner, staff: { id: actor.id, fullName: actor.name }, service: currentService(ctx), serverTime: ctx.clock().toISOString() };
  });

  app.get('/scanner/recent', async (req) => {
    const { scanner } = requireScanner(req);
    return { scans: recentScans(ctx, scanner.id, 20) };
  });
}
