// Deterministic PRNG (mulberry32) + helpers. No Date.now()/Math.random() anywhere in the generators.
export type Rng = ReturnType<typeof makeRng>;

export function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), // inclusive
    chance: (p: number) => next() < p,
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)],
    /** weighted pick; weights need not sum to 1 */
    weighted: (weights: readonly number[]): number => {
      let total = 0;
      for (const w of weights) total += w;
      let r = next() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r < 0) return i;
      }
      return weights.length - 1;
    },
    hex: (n: number): string => {
      let s = "";
      for (let i = 0; i < n; i++) s += Math.floor(next() * 16).toString(16);
      return s;
    },
  };
}

/** Deterministic UUID-shaped guid, upper-case like macOS. */
export function fakeGuid(rng: Rng): string {
  const h = rng.hex(32).toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-A${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function hashSeed(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const ch of parts.join("|")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
