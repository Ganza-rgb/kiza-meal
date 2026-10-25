import {
  createHash,
  createPublicKey,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// scrypt N=2^15, r=8, p=1 (~32 MiB, ~100 ms on a laptop): strong enough for staff passwords
// while keeping logins responsive on a modest local server.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

/** Automated tests may lower the cost (KIZA_FAST_HASH=1); never honoured in production. */
function scryptParams() {
  if (process.env.KIZA_FAST_HASH === '1' && process.env.NODE_ENV !== 'production') return { ...SCRYPT, N: 1 << 10 };
  return SCRYPT;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const params = scryptParams();
  const hash = await scryptAsync(password.normalize('NFKC'), salt, KEYLEN, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scryptAsync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Used to keep login timing similar whether or not the account exists. */
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('kiza-timing-equaliser');
  await verifyPassword(password, await dummyHash);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Short human-typeable code without ambiguous characters (no 0/O, 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newHumanCode(length = 8): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

export function normaliseHumanCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

/** Raw 32-byte Ed25519 public key (base64url) -> KeyObject. Throws if the key is malformed. */
export function ed25519PublicKey(rawBase64Url: string): KeyObject {
  const raw = Buffer.from(rawBase64Url, 'base64url');
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

export function verifyEd25519(publicKey: KeyObject, message: string, signatureB64Url: string): boolean {
  const sig = Buffer.from(signatureB64Url, 'base64url');
  if (sig.length !== 64) return false;
  try {
    return verify(null, Buffer.from(message, 'utf8'), publicKey, sig);
  } catch {
    return false;
  }
}
