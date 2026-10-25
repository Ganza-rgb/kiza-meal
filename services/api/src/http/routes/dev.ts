// DEVELOPMENT ONLY (KIZA_DEV_TOOLS=1, refused when NODE_ENV=production).
// Shows live meal-pass QR codes for the [TEST] students created by `npm run seed:dev`, so the
// scanner can be tried with a single phone by pointing it at the computer screen.

import { createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { buildQrPayload, qrSignedMessage, QR_ROTATE_SECONDS } from '@kiza/shared';
import type { Ctx } from '../../context';

export interface DevTestDevice {
  studentNumber: string;
  fullName: string;
  deviceId: string;
  publicKey: string; // base64url raw
  secretKey: string; // base64url raw seed — dev fixture only
}

export const devKeysFile = (ctx: Ctx) => path.join(ctx.config.dataDir, 'dev-test-devices.json');

function loadDevDevices(ctx: Ctx): DevTestDevice[] {
  const file = devKeysFile(ctx);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as DevTestDevice[]) : [];
}

export function devSignQr(device: DevTestDevice, issuedAt: number): string {
  const key = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: device.secretKey, x: device.publicKey },
    format: 'jwk',
  });
  const sig = sign(null, Buffer.from(qrSignedMessage(device.deviceId, issuedAt)), key).toString('base64url');
  return buildQrPayload(device.deviceId, issuedAt, sig);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function devRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/dev/qr', async (_req, reply) => {
    const devices = loadDevDevices(ctx);
    const issuedAt = Math.floor(ctx.clock().getTime() / 1000);
    const cards = await Promise.all(
      devices.map(async (d) => {
        const svg = await QRCode.toString(devSignQr(d, issuedAt), { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
        return `<figure><div class="qr">${svg}</div><figcaption><b>${esc(d.fullName)}</b><br>${esc(d.studentNumber)}</figcaption></figure>`;
      }),
    );
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${QR_ROTATE_SECONDS}"><title>Kiza dev QR</title>
<style>body{font-family:system-ui;background:#F6F1E7;color:#1F1A17;margin:24px}
h1{font-size:20px}p{max-width:640px}main{display:flex;flex-wrap:wrap;gap:24px}
figure{background:#fff;padding:16px;border-radius:12px;margin:0;width:260px;text-align:center;border:2px solid #1F1A17}
.qr svg{width:228px;height:228px}.warn{background:#B23A2E;color:#fff;padding:8px 12px;border-radius:8px;display:inline-block}</style></head>
<body><span class="warn">DEVELOPMENT TEST DATA — NOT REAL STUDENTS</span><h1>Kiza — test meal passes</h1>
<p>These codes are signed with keys created by <code>npm run seed:dev</code>. They refresh every ${QR_ROTATE_SECONDS}s.
Scan them with the Kiza scanner during a meal window.</p>
<main>${cards.join('') || '<p>No test devices. Run <code>npm run api:seed:dev</code> first.</p>'}</main></body></html>`;
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  });
}
