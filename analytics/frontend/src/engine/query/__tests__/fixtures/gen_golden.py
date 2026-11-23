"""
Regenerates fixture.json (deterministic synthetic data) and golden.json (responses of the legacy
Python /api/conversations/* routes over that data). Run from anywhere:

    python3 gen_golden.py

Requires the analytics/backend dependencies (fastapi, httpx, vaderSentiment, emoji).
"""
import json
import random
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[4].parent / "backend"
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "tests"))

ME = "me"
ALICE, BOB, CAROL, DAVE, ERIN = "+15552220001", "+15552220002", "carol@example.com", "+15552220004", "+15552220005"
NAMES = {ALICE: "Alice A", BOB: "Bob B"}  # contacts; everyone else falls back to the handle

TEXTS = [
    "hey", "what's up", "lol that's so funny", "I LOVE THIS SO MUCH", "ok sounds good", "on my way",
    "can you call me?", "I'm so happy today \U0001F600\U0001F600", "this is terrible, I hate it \U0001F621",
    "love you ❤️", "sleeping", "wanna grab dinner tonight?", "Sure thing!", "haha yes",
    "no way", "see you at 5", "thanks!!!", "good morning", "100% agree", "wtf is going on",
    "a much longer message that goes on and on to be the longest one in the conversation, really, "
    "it just keeps going and going so that length based records have something to find",
    "100% (really) _underscore_ test", "’curly apostrophe’ test",
]
ACTIONS = ["Loved", "Liked", "Laughed", "Disliked", "Emphasized", "Questioned"]


def build():
    rnd = random.Random(1234)
    participants = [
        {"id": ME, "phone_num": "+15551110000", "email": None, "is_me": 1},
        {"id": ALICE, "phone_num": ALICE, "email": None, "is_me": 0},
        {"id": BOB, "phone_num": BOB, "email": None, "is_me": 0},
        {"id": CAROL, "phone_num": None, "email": CAROL, "is_me": 0},
        {"id": DAVE, "phone_num": DAVE, "email": None, "is_me": 0},
        {"id": ERIN, "phone_num": ERIN, "email": None, "is_me": 0},
    ]
    convs = [
        ("c1", 0, "close_friend", None, [ME, ALICE], 260),
        ("c2", 1, "friend", None, [ME, ALICE, BOB, CAROL], 220),
        ("c3", 0, "other", None, [ME, DAVE], 60),
        ("c4", 1, "family", "Trip Crew", [ME, ALICE, BOB, CAROL, DAVE], 25),
        ("c5", 0, "other", None, [ME, ERIN], 0),
    ]
    conversations, cps, messages, tapbacks, announcements = [], [], [], [], []
    start = datetime(2024, 1, 3, 9, 0, 0)
    for ci, (cid, grp, rel, name, members, n) in enumerate(convs):
        conversations.append({"id": cid, "is_group_chat": grp, "relationship_type": rel, "convo_name": name})
        for m in members:
            cps.append({"conversation_id": cid, "participant_id": m})
        t = start + timedelta(days=ci * 3)
        ids = []
        last_sender = None
        for i in range(n):
            r = rnd.random()
            if r < 0.04:
                t += timedelta(days=rnd.randint(2, 9))
            elif r < 0.12:
                t += timedelta(hours=rnd.randint(7, 20))
            elif r < 0.2:
                pass  # same-second tie
            else:
                t += timedelta(seconds=rnd.randint(5, 4000))
            mid = f"{cid}-m{i:03d}"
            sender = rnd.choice(members) if rnd.random() < 0.6 or last_sender is None else last_sender
            last_sender = sender
            text = rnd.choice(TEXTS) if rnd.random() > 0.05 else ""
            reply_to = rnd.choice(ids) if ids and rnd.random() < 0.18 else None
            messages.append({
                "id": mid, "conversation_id": cid, "sender_id": sender, "timestamp": t.isoformat(),
                "text": text, "has_attachment": int(text == "" or rnd.random() < 0.05),
                "has_sticker": int(rnd.random() < 0.02), "reply_to": reply_to,
            })
            ids.append(mid)
            if rnd.random() < 0.25:
                seen = set()
                for _ in range(rnd.randint(1, 3)):
                    reactor = rnd.choice(members)
                    action = rnd.choice(ACTIONS)
                    if (reactor, action) not in seen:
                        seen.add((reactor, action))
                        tapbacks.append({"message_id": mid, "reactor_id": reactor, "action": action})
        if grp:
            ts = start + timedelta(days=ci * 3 + 1)
            evs = [("renamed convo", ALICE, None), ("added person", ALICE, CAROL), ("changed photo", BOB, None),
                   ("left convo", BOB, BOB), ("added person", ME, BOB), ("removed person", ME, CAROL),
                   ("unsent message", CAROL, None), ("changed photo", BOB, None), ("renamed convo", BOB, None)]
            for j, (act, annc, aff) in enumerate(evs):
                announcements.append({
                    "id": f"{cid}-a{j}", "conversation_id": cid,
                    "datetime": (ts + timedelta(days=j * 2, hours=j)).isoformat(),
                    "announcer_id": annc, "action": act, "affected_id": aff,
                })
    return {
        "participants": participants, "conversations": conversations, "conversation_participants": cps,
        "messages": messages, "tapbacks": tapbacks, "announcements": announcements,
        "contacts": [{"handle": k, "display_name": v} for k, v in NAMES.items()],
    }


class Resolver:
    def resolve(self, handle):
        return NAMES.get(handle)


def load_legacy(fx):
    from conftest import SCHEMA
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    conn.execute("CREATE INDEX idx_messages_convo_ts_id ON messages(conversation_id, timestamp, id)")
    for table, rows in fx.items():
        if table == "contacts":
            continue
        for r in rows:
            cols = ",".join(r)
            conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({','.join('?' for _ in r)})", list(r.values()))
    conn.commit()
    return conn


def main():
    fx = build()
    (HERE / "fixture.json").write_text(json.dumps(fx, separators=(",", ":")))
    conn = load_legacy(fx)

    from fastapi.testclient import TestClient
    from dependencies import get_db, get_resolver
    from main import app

    app.dependency_overrides[get_db] = lambda: conn
    app.dependency_overrides[get_resolver] = lambda: Resolver()
    client = TestClient(app)

    def msgs(cid):
        return [m["id"] for m in fx["messages"] if m["conversation_id"] == cid]

    m = msgs("c1")
    urls = ["/api/conversations", "/api/conversations?sort=count", "/api/conversations?search=alice",
            "/api/conversations?page=2&page_size=2", "/api/conversations?search=zzz",
            "/api/conversations/nope", "/api/conversations/nope/messages"]
    for cid in ["c1", "c2", "c3", "c4", "c5"]:
        base = f"/api/conversations/{cid}"
        urls += [base, f"{base}/volume?granularity=day", f"{base}/volume?granularity=week",
                 f"{base}/volume?granularity=month", f"{base}/participant-stats",
                 f"{base}/personality-leaderboard", f"{base}/messages", f"{base}/messages?limit=7",
                 f"{base}/heatmap", f"{base}/streak-silence", f"{base}/group-size", f"{base}/join-leave",
                 f"{base}/leaderboard", f"{base}/reply-graph", f"{base}/messages/search?q=love",
                 f"{base}/messages/search?q=100%25&limit=5", f"{base}/messages/search?q=_under",
                 f"{base}/messages/search?q=LO"]
    urls += [f"/api/conversations/c1/messages?before={m[100]}&limit=10",
             f"/api/conversations/c1/messages?after={m[100]}&limit=10",
             f"/api/conversations/c1/messages?after={m[-1]}&limit=10",
             f"/api/conversations/c1/messages?around={m[50]}&limit=11",
             f"/api/conversations/c1/messages?around={m[0]}&limit=10",
             f"/api/conversations/c1/messages?around={m[-1]}&limit=10",
             "/api/conversations/c1/messages?date=2024-01-10&limit=20",
             "/api/conversations/c1/messages?date=2030-01-01&limit=20",
             "/api/conversations/c1/messages?date=2000-01-01&limit=20",
             "/api/conversations/c1/messages?before=bogus&limit=5",
             "/api/conversations/c1/messages?around=bogus",
             "/api/conversations/c1/messages?date=nope"]
    golden = {}
    for u in urls:
        r = client.get(u)
        golden[u] = {"status": r.status_code, "body": r.json()}
    (HERE / "golden.json").write_text(json.dumps(golden, indent=1, sort_keys=True))
    print(f"{len(urls)} responses written")


if __name__ == "__main__":
    main()
