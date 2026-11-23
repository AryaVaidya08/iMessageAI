// Minimal typedstream reader for message.attributedBody (NSAttributedString archived by
// NSArchiver, "streamtyped"). Follows imessage-exporter's attributed_body parsing: find
// the NSString class record, then the '+' (0x2B) string element and read its
// length-prefixed UTF-8 bytes.

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");
const NSSTRING = enc.encode("NSString");

function indexOfBytes(buf: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= buf.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (buf[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function toBytes(v: unknown): Uint8Array | null {
  if (v == null) return null;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

/** Decode the plain text out of an attributedBody blob, or null if not found. */
export function decodeAttributedBody(blob: unknown): string | null {
  const buf = toBytes(blob);
  if (!buf || buf.length < 16) return null;
  const i = indexOfBytes(buf, NSSTRING);
  if (i < 0) return null;
  const start = i + NSSTRING.length;
  // After the class record: 0x01 0x94 0x84 0x01 0x2B (varies); locate "01 2B".
  const limit = Math.min(buf.length - 2, start + 64);
  let p = -1;
  for (let k = start; k < limit; k++) {
    if (buf[k] === 0x01 && buf[k + 1] === 0x2b) {
      p = k + 2;
      break;
    }
  }
  if (p < 0) return null;
  // Typedstream integer: <0x80 literal; 0x81 -> int16 LE; 0x82 -> int32 LE.
  let len: number;
  const b = buf[p++];
  if (b === 0x81) {
    len = buf[p] | (buf[p + 1] << 8);
    p += 2;
  } else if (b === 0x82) {
    len = (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0;
    p += 4;
  } else if (b < 0x80) len = b;
  else return null;
  if (p + len > buf.length) len = buf.length - p; // lenient on truncation
  if (len <= 0) return "";
  return dec.decode(buf.subarray(p, p + len));
}
