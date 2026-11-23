"""Build a deterministic fixture DB (legacy schema + contacts) and dump golden overview
outputs produced by the ORIGINAL Python implementation.
  python3 analytics/frontend/scripts/overview-golden.py
Writes overview.fixture.db and overview.golden.json into src/engine/query/__fixtures__/."""
import importlib.util, json, random, sqlite3, sys
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "analytics" / "backend"))
spec = importlib.util.spec_from_file_location("schema", ROOT / "backend" / "storage" / "schema.py")
schema = importlib.util.module_from_spec(spec)
spec.loader.exec_module(schema)
from services import queries, stats  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "src" / "engine" / "query" / "__fixtures__"
OUT.mkdir(parents=True, exist_ok=True)
DB = OUT / "overview.fixture.db"
DB.unlink(missing_ok=True)
conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
conn.executescript(schema.SCHEMA)
conn.executescript("""
ALTER TABLE participants ADD COLUMN handle TEXT;
ALTER TABLE participants ADD COLUMN display_name TEXT;
CREATE TABLE contacts (handle TEXT PRIMARY KEY, display_name TEXT);
CREATE TABLE participant_alias (from_id TEXT PRIMARY KEY, to_id TEXT NOT NULL);
CREATE TABLE conversation_alias (from_id TEXT PRIMARY KEY, to_id TEXT NOT NULL);
""")
people = [("me", None, None, 1), ("+15551110001", "+15551110001", None, 0), ("+15551110002", "+15551110002", None, 0),
          ("bob@example.com", None, "bob@example.com", 0), ("+15551110004", "+15551110004", None, 0)]
for pid, ph, em, me in people:
    conn.execute("INSERT INTO participants(id,phone_num,email,is_me,handle) VALUES (?,?,?,?,?)", (pid, ph, em, me, ph or em))
contacts = {"+15551110001": "Alice A", "bob@example.com": "Bob B", "+15551110002": "Carol C"}
for h, n in contacts.items():
    conn.execute("INSERT INTO contacts VALUES (?,?)", (h, n))

convs = [("c1", 0, "friend", None, ["me", "+15551110001"]),
         ("c2", 0, "family", None, ["me", "bob@example.com"]),
         ("c3", 1, "friend", None, ["me", "+15551110001", "+15551110002", "bob@example.com", "+15551110004"]),
         ("c4", 1, "coworker", "Work Crew", ["me", "+15551110002", "+15551110004"]),
         ("c5", 0, "family", None, ["me", "+15551110004"])]
for cid, g, rel, name, members in convs:
    conn.execute("INSERT INTO conversations VALUES (?,?,?,?)", (cid, g, rel, name))
    for m in members:
        conn.execute("INSERT INTO conversation_participants VALUES (?,?)", (cid, m))

rng = random.Random(7)
n = 0
for cid, g, rel, name, members in convs:
    t = datetime(2022, 11, 27, 9, 0, 0) + timedelta(days=rng.randint(0, 30))
    for i in range(rng.randint(60, 140)):
        t += timedelta(seconds=rng.choice([1, 5, 30, 90, 600, 4000, 40000, 100000, 700000]) + rng.random() * 0.9)
        n += 1
        conn.execute("INSERT INTO messages(id,conversation_id,sender_id,timestamp,text) VALUES (?,?,?,?,?)",
                     (f"m{n}", cid, rng.choice(members),
                      t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z", "hi"))
conn.commit()


class R:
    def resolve(self, h):
        return contacts.get(h)


golden = {
    "stats": queries.get_overview_stats(conn),
    "volume": {g: [{"bucket": b, "count": c} for b, c in stats.bucket_volume(queries.get_daily_message_counts(conn), g)]
               for g in ("day", "week", "month")},
    "top": {str(l): queries.get_top_conversations(conn, R(), l) for l in (1, 3, 10)},
    "heatmap": {"grid": stats.build_heatmap_grid(queries.get_global_dow_hour_counts(conn))},
    "fastest": queries.get_fastest_reply_relationship_type(conn),
}
conn.close()
(OUT / "overview.golden.json").write_text(json.dumps(golden, indent=1, default=str))
print("ok", n, golden["stats"], golden["fastest"])
