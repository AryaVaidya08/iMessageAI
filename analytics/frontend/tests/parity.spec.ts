// Parity: run every legacy FastAPI route case against the TS engine and diff with tests/golden/*.json.
//
// SKIPPED until the engine units merge. To enable: implement tests/helpers/engine-impl.ts (see helpers/engine.ts), then
//   npm run test:parity        (sets PARITY_ENGINE=1)
// The always-on "golden integrity" block below runs in plain `npm test` and keeps the harness honest.
//
// Regenerate goldens (legacy Python): npm run make-fixtures && npm run make-goldens
// ID differences are normalized by helpers/diff.ts: legacy uuid5s -> tokens via golden/_idmap.json; new ids
// (chat guid / handle / message guid) -> same tokens. Timestamps compare at ms precision, floats at 1e-6 rel.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { diff, normalize } from "./helpers/diff";
import { legacyTokens, loadEngine, newEngineTokens, resolvePlaceholders, type ParityEngine } from "./helpers/engine";
import { ensureFixtures, fixturePath, CACHE_DIR } from "../scripts/make-fixtures";

const GOLDEN = join(fileURLToPath(new URL(".", import.meta.url)), "golden");
interface Case { name: string; method: string; path: string; body?: Record<string, string> }
const cases: Case[] = JSON.parse(readFileSync(join(GOLDEN, "cases.json"), "utf8")).cases;
const idmap = JSON.parse(readFileSync(join(GOLDEN, "_idmap.json"), "utf8"));

/** case name -> reason. Documented, intentional engine-vs-legacy differences; these cases are skipped. */
const KNOWN_DIVERGENCES: Record<string, string> = {};

/**
 * case name -> JSON paths excluded from the diff, with the reason. These are differences in the LEGACY side's
 * arbitrary choices, not engine bugs; every other path in the case is still compared.
 */
const IGNORED_PATHS: Record<string, { paths: string[]; reason: string }> = {
  "conv-group-leaderboard": {
    paths: ["$.most_revolving_door", "$.top_unsender"],
    reason:
      "most_revolving_door: three people tie at one event each and the legacy winner follows random uuid order. " +
      "top_unsender: make-goldens.py drops unsent messages, the real legacy parser (and the engine) records 'unsent message' announcements.",
  },
  "conv-email-leaderboard": {
    paths: ["$.top_unsender"],
    reason: "make-goldens.py drops unsent messages; the engine records 'unsent message' announcements like the legacy parser.",
  },
  "person-me-detail": {
    paths: ["$.leaderboard.most_emoji_message", "$.leaderboard.top_unsender"],
    reason:
      "most_emoji_message: equal emoji counts, legacy tie goes to the first message in random-uuid conversation order. " +
      "top_unsender: see conv-email-leaderboard.",
  },
};

describe("golden integrity (always on)", () => {
  it("every case has a golden file with a status", () => {
    for (const c of cases) {
      const f = join(GOLDEN, `${c.name}.json`);
      expect(existsSync(f), c.name).toBe(true);
      expect(JSON.parse(readFileSync(f, "utf8")).status).toBeTypeOf("number");
    }
  });
  it("has no stray golden files", () => {
    const names = new Set(cases.map((c) => `${c.name}.json`));
    for (const f of readdirSync(GOLDEN)) {
      if (f === "cases.json" || f === "_idmap.json") continue;
      expect(names.has(f), f).toBe(true);
    }
  });
});

describe.skipIf(!process.env.PARITY_ENGINE)("legacy route parity", () => {
  let engine: ParityEngine;
  let chatDb: string;
  let legacy: Map<string, string>;
  let fresh: Map<string, string>;

  beforeAll(async () => {
    ensureFixtures(["small"]);
    chatDb = fixturePath("small");
    legacy = legacyTokens(idmap);
    fresh = newEngineTokens(chatDb);
    engine = await loadEngine({ chatDbPath: chatDb, addressBookDir: join(CACHE_DIR, "addressbook") });
  }, 120_000);
  afterAll(async () => engine?.close());

  // Cases run sequentially in file order: POST cases (relationship edit, merges) are last and stateful.
  for (const c of cases) {
    const run = KNOWN_DIVERGENCES[c.name] ? it.skip : it;
    run(c.name, async () => {
      const golden = JSON.parse(readFileSync(join(GOLDEN, `${c.name}.json`), "utf8"));
      const path = resolvePlaceholders(c.path, chatDb);
      const body = c.body ? JSON.parse(resolvePlaceholders(JSON.stringify(c.body), chatDb).replace(/%[0-9A-F]{2}/g, decodeURIComponent)) : undefined;
      const res = await engine.request(c.method, path, body);
      expect(res.status, `${c.method} ${path}`).toBe(golden.status);
      const ignored = IGNORED_PATHS[c.name]?.paths ?? [];
      const problems = diff(normalize(golden.body, legacy), normalize(res.body, fresh)).filter(
        (p) => !ignored.some((ip) => p.startsWith(ip + ":") || p.startsWith(ip + ".") || p.startsWith(ip + "[")),
      );
      expect(problems, problems.join("\n")).toEqual([]);
    });
  }
});
