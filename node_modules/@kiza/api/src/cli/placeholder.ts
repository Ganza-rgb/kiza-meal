import { crc32, deflateSync } from 'node:zlib';

/** Tiny geometric placeholder portrait (PNG) for [TEST] students. Never used for real students. */
export function placeholderPng(seed: number, size = 96): Buffer {
  const colors = [
    [0xb5, 0x4a, 0x2a],
    [0x6b, 0x4a, 0x35],
    [0x2b, 0x25, 0x21],
  ][seed % 3]!;
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.abs(x - size / 2) + Math.abs(y - size / 2);
      const on = Math.floor(d / 8) % 2 === 0;
      const o = y * stride + 1 + x * 3;
      raw[o] = on ? colors[0]! : 0xf6;
      raw[o + 1] = on ? colors[1]! : 0xf1;
      raw[o + 2] = on ? colors[2]! : 0xe7;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
