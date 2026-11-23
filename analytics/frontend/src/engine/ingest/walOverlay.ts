// SQLite write-ahead-log replay, read-only: finds, for every database page, the latest COMMITTED
// frame in a copied chat.db-wal so the VFS can serve that page instead of the one in chat.db.
// Format: https://www.sqlite.org/fileformat2.html#walformat

export interface WalSource {
  readonly size: number;
  read(offset: number, length: number): Uint8Array;
}

export interface WalOverlay {
  pageSize: number;
  /** database size in pages after the last commit */
  dbPages: number;
  /** page number (1-based) -> byte offset of that page's data in the WAL file */
  pages: Map<number, number>;
  /** committed frames used */
  frames: number;
}

const MAGIC_LE = 0x377f0682; // checksums computed on little-endian words
const MAGIC_BE = 0x377f0683;

function checksum(data: Uint8Array, start: number, end: number, big: boolean, s0: number, s1: number): [number, number] {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = start; i + 8 <= end; i += 8) {
    s0 = (s0 + dv.getUint32(i, !big) + s1) >>> 0;
    s1 = (s1 + dv.getUint32(i + 4, !big) + s0) >>> 0;
  }
  return [s0, s1];
}

/**
 * Returns null when the WAL is empty/unusable (wrong page size, bad header). Frames after the
 * last valid commit, frames from an older WAL generation (different salts) and torn frames are ignored.
 */
export function parseWal(wal: WalSource, expectedPageSize: number): WalOverlay | null {
  if (wal.size < 32) return null;
  const head = wal.read(0, 32);
  const hv = new DataView(head.buffer, head.byteOffset, 32);
  const magic = hv.getUint32(0, false);
  if (magic !== MAGIC_LE && magic !== MAGIC_BE) return null;
  const pageSize = hv.getUint32(8, false);
  if (pageSize !== expectedPageSize) return null;
  const big = magic === MAGIC_BE;
  const salt1 = hv.getUint32(16, false);
  const salt2 = hv.getUint32(20, false);
  let [s0, s1] = checksum(head, 0, 24, big, 0, 0);
  if (s0 !== hv.getUint32(24, false) || s1 !== hv.getUint32(28, false)) return null;

  const frameLen = 24 + pageSize;
  const committed = new Map<number, number>();
  let pending = new Map<number, number>();
  let dbPages = 0;
  let frames = 0;
  let pendingFrames = 0;
  for (let off = 32; off + frameLen <= wal.size; off += frameLen) {
    const frame = wal.read(off, frameLen);
    if (frame.length < frameLen) break;
    const fv = new DataView(frame.buffer, frame.byteOffset, frameLen);
    const pageNo = fv.getUint32(0, false);
    if (pageNo === 0) break;
    if (fv.getUint32(8, false) !== salt1 || fv.getUint32(12, false) !== salt2) break;
    // checksum chains: first 8 header bytes, then the page data
    let c = checksum(frame, 0, 8, big, s0, s1);
    c = checksum(frame, 24, frameLen, big, c[0], c[1]);
    if (c[0] !== fv.getUint32(16, false) || c[1] !== fv.getUint32(20, false)) break;
    [s0, s1] = c;
    pending.set(pageNo, off + 24);
    pendingFrames++;
    const commitSize = fv.getUint32(4, false);
    if (commitSize !== 0) {
      for (const [p, o] of pending) committed.set(p, o);
      pending = new Map();
      dbPages = commitSize;
      frames += pendingFrames;
      pendingFrames = 0;
    }
  }
  if (!committed.size) return null;
  return { pageSize, dbPages, pages: committed, frames };
}
