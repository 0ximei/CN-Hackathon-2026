import { describe, expect, it } from 'vitest';

import { fromBase64, toBase64 } from './base64';

/**
 * Every mesh frame crosses the native bridge through these two functions, so a
 * bug here corrupts packets rather than failing loudly. The cases that matter
 * are the ones a naive implementation gets wrong: high bytes, zero bytes, and
 * lengths that are not a multiple of three.
 */
describe('base64 bridge codec', () => {
  it('round-trips every byte value', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect([...fromBase64(toBase64(all))]).toEqual([...all]);
  });

  it('round-trips at every padding length', () => {
    for (let length = 0; length <= 16; length++) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = (i * 37 + 200) & 0xff;
      const encoded = toBase64(bytes);
      expect(encoded.length % 4, `length ${length} encodes to a whole quantum`).toBe(0);
      expect([...fromBase64(encoded)], `length ${length}`).toEqual([...bytes]);
    }
  });

  it('agrees with the platform encoder', () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0x9e, 0x37, 0x79, 0xb1, 0x80]);
    const expected = Buffer.from(bytes).toString('base64');
    expect(toBase64(bytes)).toBe(expected);
    expect([...fromBase64(expected)]).toEqual([...bytes]);
  });

  it('round-trips a realistic packet-sized payload', () => {
    const packet = new Uint8Array(517);
    for (let i = 0; i < packet.length; i++) packet[i] = (i * 131) & 0xff;
    expect([...fromBase64(toBase64(packet))]).toEqual([...packet]);
  });
});
