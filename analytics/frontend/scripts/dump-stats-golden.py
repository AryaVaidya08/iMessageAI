"""One-off: build a deterministic fixture dataset and dump the Python stats outputs to JSON.

Run with the analytics/backend venv, from analytics/backend:
  .venv/bin/python ../frontend/scripts/dump-stats-golden.py <out_dir>

Writes <out_dir>/stats-fixture.db (new-contract shape, read by the vitest golden test) and
<out_dir>/stats-golden.json (Python outputs: participant-stats, personality-leaderboard per
conversation, person stats per participant).
"""
import json
import random
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path.cwd()))
from routers import conversations as conv_router  # noqa: E402
from services import queries  # noqa: E402
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("legacy_schema", Path.cwd().parent.parent / "backend/storage/schema.py")
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
SCHEMA = _mod.SCHEMA

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)

PHRASES = [
    "love you so much!!", "WHAT THE HELL is this", "lol ok", "haha that's wild 😭😭", "thanks, really appreciate it",
    "sure... totally", "I can't believe it?!", "heyyyy what's up", "don't worry, it's fine and chill", "I hate this",
    "omg LMAO", "this is amazing 😍", "literally dying 💀", "miss you ❤️", "ok", "whatever, vibes",
    "FUCK this stupid thing", "See you tomorrow at dinner", "That was the best movie ever", "good night 😘",
    "wow great job", "Sorry I'm late", "call me when you're free", "I'm so angry 😡 right now", "😂😂😂", "",
]
PEOPLE = {
    "me": (None, None, 1),
    "+15551230001": ("+15551230001", None, 0),
    "+15551230002": ("+15551230002", None, 0),
    "a@example.com": (None, "a@example.com", 0),
}
NAMES = {"+15551230001": "Alice"}  # contact name for one participant
CONVS = {
    "c1": (0, ["me", "+15551230001"]),
    "c2": (1, ["me", "+15551230001", "+15551230002", "a@example.com"]),
    "c3": (0, ["me", "+15551230002"]),
}

rng = random.Random(42)
legacy = sqlite3.connect(":memory:")
legacy.row_factory = sqlite3.Row
legacy.executescript(SCHEMA)
for pid, (ph, em, me) in PEOPLE.items():
    legacy.execute("INSERT INTO participants VALUES (?,?,?,?)", (pid, ph, em, me))
for cid, (grp, members) in CONVS.items():
    legacy.execute("INSERT INTO conversations VALUES (?,?,?,?)", (cid, grp, "friend", None))
    for m in members:
        legacy.execute("INSERT INTO conversation_participants VALUES (?,?)", (cid, m))
    t = datetime(2024, 1, 1, 8, 0, 0)
    for i in range(400 if cid != "c3" else 15):
        t += timedelta(seconds=rng.choice([20, 90, 400, 3000, 20000, 90000]) + rng.random())
        sender = rng.choice(members)
        text = rng.choice(PHRASES)
        legacy.execute(
            "INSERT INTO messages (id, conversation_id, sender_id, timestamp, text) VALUES (?,?,?,?,?)",
            (f"{cid}-{i:04d}", cid, sender, t.isoformat(timespec="milliseconds"), text),
        )
    ids = [r[0] for r in legacy.execute("SELECT id FROM messages WHERE conversation_id=?", (cid,))]
    for _ in range(60 if cid != "c3" else 3):
        legacy.execute(
            "INSERT OR IGNORE INTO tapbacks (message_id, reactor_id, action) VALUES (?,?,?)",
            (rng.choice(ids), rng.choice(members), rng.choice(["loved", "liked", "laughed", "emphasized"])),
        )
legacy.commit()


class Resolver:
    def resolve(self, handle):
        return NAMES.get(handle)


res = Resolver()
golden = {"participant_stats": {}, "personality_leaderboard": {}, "person_stats": {}}
for cid in CONVS:
    golden["participant_stats"][cid] = json.loads(
        conv_router.get_participant_stats(cid, legacy, res).model_dump_json()
    )
    golden["personality_leaderboard"][cid] = json.loads(
        conv_router.get_personality_leaderboard(cid, legacy, res).model_dump_json()
    )
for pid in PEOPLE:
    golden["person_stats"][pid] = queries.get_person_stats(legacy, res, pid)
(out / "stats-golden.json").write_text(json.dumps(golden, indent=1, default=str))

# New-contract fixture
dbp = out / "stats-fixture.db"
dbp.unlink(missing_ok=True)
new = sqlite3.connect(dbp)
new.executescript(
    """
CREATE TABLE participants (id TEXT PRIMARY KEY, handle TEXT, display_name TEXT, is_me INTEGER NOT NULL DEFAULT 0);
CREATE TABLE conversation_participants (conversation_id TEXT NOT NULL, participant_id TEXT NOT NULL,
  PRIMARY KEY (conversation_id, participant_id));
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL,
  timestamp TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX idx_messages_convo_ts_id ON messages(conversation_id, timestamp, id);
CREATE TABLE tapbacks (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, reactor_id TEXT NOT NULL,
  action TEXT NOT NULL, UNIQUE(message_id, reactor_id, action));
"""
)
for r in legacy.execute("SELECT * FROM participants"):
    new.execute(
        "INSERT INTO participants VALUES (?,?,?,?)",
        (r["id"], r["phone_num"] or r["email"], NAMES.get(r["phone_num"] or ""), r["is_me"]),
    )
for r in legacy.execute("SELECT * FROM conversation_participants"):
    new.execute("INSERT INTO conversation_participants VALUES (?,?)", tuple(r))
for r in legacy.execute("SELECT id, conversation_id, sender_id, timestamp, text FROM messages"):
    new.execute("INSERT INTO messages VALUES (?,?,?,?,?)", tuple(r))
for r in legacy.execute("SELECT message_id, reactor_id, action FROM tapbacks ORDER BY id"):
    new.execute("INSERT INTO tapbacks (message_id, reactor_id, action) VALUES (?,?,?)", tuple(r))
new.commit()
print("wrote", out)
