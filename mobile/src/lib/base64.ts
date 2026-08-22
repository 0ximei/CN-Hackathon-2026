/**
 * Base64 for the native bridge.
 *
 * Hermes has shipped `atob`/`btoa` for a while, but they are defined over
 * latin-1 strings: round-tripping bytes through them means building a string
 * one `charCodeAt` at a time and hoping nothing in between decides it is UTF-8.
 * Mesh frames are binary — a packet header is full of high bytes — so this
 * converts the array directly and leaves no room for that.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const LOOKUP = /* @__PURE__ */ (() => {
  const table = new Uint8Array(128).fill(255);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      ALPHABET[(n >> 18) & 63] +
      ALPHABET[(n >> 12) & 63] +
      ALPHABET[(n >> 6) & 63] +
      ALPHABET[n & 63];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + '==';
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + '=';
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  let end = text.length;
  while (end > 0 && text[end - 1] === '=') end--;
  const out = new Uint8Array(Math.floor((end * 3) / 4));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (let i = 0; i < end; i++) {
    const code = text.charCodeAt(i);
    const digit = code < 128 ? LOOKUP[code] : 255;
    if (digit === 255) continue; // whitespace and stray characters
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (value >> bits) & 0xff;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}
