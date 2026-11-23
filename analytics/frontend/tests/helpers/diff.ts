// Normalization + tolerant structural diff used by the parity spec (and unit-tested in diff.spec.ts).

export type Tokens = Map<string, string>;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:Z|[+-]00:?00)?$/;

/** Keys whose values are wall-clock/volatile and are ignored by the diff. */
export const VOLATILE_KEYS = new Set(["merged_at"]);

/** Canonicalize an ISO-8601 timestamp to `YYYY-MM-DDTHH:MM:SS.mmm` (UTC, ms). Non-timestamps pass through. */
export function canonTimestamp(s: string): string {
  const m = ISO_RE.exec(s);
  if (!m) return s;
  return `${m[1]}T${m[2]}.${(m[3] ?? "").padEnd(3, "0").slice(0, 3)}`;
}

/**
 * Replace engine-specific ids with neutral tokens (`conv:<chat guid>`, `person:<handle>`, `msg:<guid>`).
 * Legacy side: uuids found in goldens/_idmap.json. New side: chat guids / handles / message guids are
 * themselves the ids, so the token map is identity-with-prefix and matches whole strings only.
 */
/** Keys whose arrays are compared as sets (keyed by id): legacy order follows random uuid order. */
const ID_SORTED_KEYS = new Set(["participants", "conversations"]);
/** display-name style strings that join member names with ", "; legacy member order is uuid order. */
const NAME_LIST_KEYS = new Set(["display_name", "subtext"]);

/** Top-N count lists: ties are listed in legacy random-uuid order, so canonicalize ties (count desc, then label). */
const TIE_SORTED_KEYS = new Set(["top_words", "top_emojis", "tapbacks_given", "tapbacks_received"]);

export function normalize(value: unknown, tokens: Tokens, key?: string): unknown {
  if (typeof value === "string") {
    const whole = tokens.get(value);
    if (whole) return whole;
    const s = canonTimestamp(value.replace(UUID_RE, (u) => tokens.get(u) ?? u));
    if (key && NAME_LIST_KEYS.has(key) && s.includes(", ")) return s.split(", ").sort().join(", ");
    return s;
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => normalize(v, tokens, key));
    if (key && ID_SORTED_KEYS.has(key) && items.every((v) => v && typeof v === "object" && ("id" in (v as object) || "participant_id" in (v as object) || "conversation_id" in (v as object)))) {
      const idOf = (v: Record<string, unknown>) => String(v.id ?? v.participant_id ?? v.conversation_id);
      items.sort((a, b) => idOf(a as Record<string, unknown>).localeCompare(idOf(b as Record<string, unknown>)));
    }
    if (key && TIE_SORTED_KEYS.has(key) && items.every((v) => v && typeof v === "object" && "count" in (v as object))) {
      const label = (v: Record<string, unknown>) => String(v.word ?? v.emoji ?? v.action ?? "");
      items.sort((a, b) => {
        const x = a as Record<string, number>;
        const y = b as Record<string, number>;
        return y.count - x.count || label(a as Record<string, unknown>).localeCompare(label(b as Record<string, unknown>));
      });
      // Which of several equal-count entries make the cut-off is arbitrary in legacy: mask the labels of the
      // final tie group (counts are still compared).
      const last = (items[items.length - 1] as Record<string, unknown> | undefined)?.count;
      for (const it of items as Record<string, unknown>[]) {
        if (it.count === last) {
          for (const k of ["word", "emoji", "action"]) if (k in it) it[k] = "~tie";
        }
      }
    }
    return items;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = normalize((value as Record<string, unknown>)[k], tokens, k);
    }
    return out;
  }
  return value;
}

export interface DiffOptions {
  relTol?: number;
  absTol?: number;
  maxDiffs?: number;
}

export function diff(expected: unknown, actual: unknown, opts: DiffOptions = {}): string[] {
  const { relTol = 1e-6, absTol = 1e-9, maxDiffs = 25 } = opts;
  const out: string[] = [];
  const walk = (e: unknown, a: unknown, path: string) => {
    if (out.length >= maxDiffs) return;
    if (typeof e === "number" && typeof a === "number") {
      if (Math.abs(e - a) > Math.max(absTol, relTol * Math.max(Math.abs(e), Math.abs(a)))) {
        out.push(`${path}: expected ${e}, got ${a}`);
      }
      return;
    }
    if (Array.isArray(e) || Array.isArray(a)) {
      if (!Array.isArray(e) || !Array.isArray(a)) return void out.push(`${path}: array/non-array mismatch`);
      if (e.length !== a.length) out.push(`${path}: length ${e.length} vs ${a.length}`);
      for (let i = 0; i < Math.min(e.length, a.length); i++) walk(e[i], a[i], `${path}[${i}]`);
      return;
    }
    if (e && a && typeof e === "object" && typeof a === "object") {
      const eo = e as Record<string, unknown>;
      const ao = a as Record<string, unknown>;
      for (const k of new Set([...Object.keys(eo), ...Object.keys(ao)])) {
        if (!(k in ao)) out.push(`${path}.${k}: missing in actual`);
        else if (!(k in eo)) out.push(`${path}.${k}: unexpected in actual`);
        else walk(eo[k], ao[k], `${path}.${k}`);
      }
      return;
    }
    if (e !== a) out.push(`${path}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
  };
  walk(expected, actual, "$");
  return out;
}
