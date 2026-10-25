// Meal-pass QR format (version 1):
//
//   KZ1.<deviceId>.<issuedAtSeconds>.<signature>
//
// - deviceId: random id the server assigned to the student's registered phone (not the student number).
// - issuedAtSeconds: Unix time from the student's phone, corrected by the server-time offset.
// - signature: Ed25519 over "KZ1.<deviceId>.<issuedAtSeconds>", base64url, made with a private key
//   that never leaves the student's phone (stored in the OS secure store).
//
// The QR carries no name, balance or entitlement. The server looks up the device, verifies the
// signature and freshness, and decides entitlement itself.

export const QR_VERSION = 'KZ1';
/** How often the student app redraws the code. */
export const QR_ROTATE_SECONDS = 15;
/** Default server-side acceptance window (configurable on the server). */
export const QR_DEFAULT_MAX_AGE_SECONDS = 90;
export const QR_MAX_FUTURE_SKEW_SECONDS = 30;

const QR_PATTERN = /^KZ1\.([A-Za-z0-9_-]{16,64})\.(\d{9,11})\.([A-Za-z0-9_-]{80,90})$/;

export interface ParsedQr {
  deviceId: string;
  issuedAt: number;
  signature: string;
  signedMessage: string;
}

export function qrSignedMessage(deviceId: string, issuedAt: number): string {
  return `${QR_VERSION}.${deviceId}.${issuedAt}`;
}

export function buildQrPayload(deviceId: string, issuedAt: number, signature: string): string {
  return `${qrSignedMessage(deviceId, issuedAt)}.${signature}`;
}

export function parseQrPayload(raw: string): ParsedQr | null {
  const match = QR_PATTERN.exec(raw.trim());
  if (!match) return null;
  const [, deviceId, issued, signature] = match;
  if (!deviceId || !issued || !signature) return null;
  const issuedAt = Number(issued);
  if (!Number.isSafeInteger(issuedAt)) return null;
  return { deviceId, issuedAt, signature, signedMessage: qrSignedMessage(deviceId, issuedAt) };
}
