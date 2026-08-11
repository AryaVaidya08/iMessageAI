# iMessage Analytics

A read-only local web app for visualizing the iMessage data parsed by `backend/` into `backend/storage/data/imessages.db`.

## Quick start

```bash
cd analytics
./start_analysis.sh
```

Starts both the backend and frontend together (installing dependencies on first run if needed). Backend at `http://localhost:8000`, frontend at `http://localhost:5173`. Ctrl+C stops both. See below for running each half manually.

### Shutting down

Press **Ctrl+C** in the terminal running `start_analysis.sh` — it stops both servers.

If a server was left running in the background (e.g. the terminal was closed instead), kill it by port or by name:

```bash
lsof -ti:8000,5173 | xargs kill
# or
pkill -f "uvicorn main:app"
pkill -f vite
```

## Backend (FastAPI)

```bash
cd analytics/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Runs at `http://localhost:8000` (interactive docs at `/docs`). Reads `backend/storage/data/imessages.db` read-only by default; override the path with `IMESSAGE_DB_PATH=/path/to/imessages.db`.

Contact name resolution uses `ContactResolver` (macOS AddressBook) and requires Full Disk Access for the terminal/IDE running the backend. Without it, the app falls back to showing raw phone numbers/emails — no error, no crash.

Run tests:

```bash
cd analytics/backend
source .venv/bin/activate
python3 -m pytest tests/ -v
```

## Frontend (React + Vite)

```bash
cd analytics/frontend
npm install
npm run dev
```

Runs at `http://localhost:5173`. Expects the backend to be running at `http://localhost:8000` (CORS is pre-configured for this pairing).

## Notes

- Read-only: nothing in this app writes to the database.
- Single-user, local tool: no authentication.
- `backend/` (top-level) is reference-only — this app never imports its Python code, only reads the SQLite file it produces.

## Known limitations

Minor, non-blocking items surfaced during code review and QA. None affect the golden path against real data (verified against the full 607,700-message / 904-conversation database, including the largest 187,111-message conversation); all are deliberate scope calls, not oversights.

- **No composite index for the largest conversations.** `get_messages_page` and `get_conversation_messages_for_stats` (`analytics/backend/services/queries.py`) aren't covered by an index on `(conversation_id, timestamp, id)` — the top-level `backend/storage/schema.py` only indexes `conversation_id` alone. `EXPLAIN QUERY PLAN` confirms an in-memory sort of the full conversation on every call for the two queries that matter most on the biggest threads. Fixing this means modifying `backend/`, which this project treats as reference-only and never edits — flagged here instead.
- **Stale/invalid pagination cursor silently resets to the newest page**, and **an empty `participants` list is used as an implicit not-found signal** rather than a distinct error, in `analytics/backend/routers/conversations.py`. Both are narrow edge cases (a hand-crafted or expired `before` cursor) that a well-behaved frontend never triggers.
- **`StatCardSkeleton` has no `aria-busy`/`role="status"`.** The loading-state signal lives one level up, on `OverviewPage`'s stat grid container (`aria-busy={stats === null}`), which is the correct boundary for a screen reader — but the skeleton itself doesn't independently announce "loading."
- **140px fixed name column** in the conversations list truncates long generated names (e.g. `"You, Person0, Person1 +3 more"`) before the `"+N more"` suffix is visible at 13px. Prescribed verbatim by the approved design spec.
- **`TapbackBreakdown` uses div-based layout, not `<table>`/`role="table"` semantics**, for what is tabular data (action + count). Matches the approved spec exactly; a screen reader still reads the content, just not with table navigation.
- **~16px scroll-jitter band on infinite scroll.** `ChatBubbleList`'s "at the top, load more" check has a 16px `padding-top`, so the trigger fires across a small range near `scrollTop = 0` rather than at an exact pixel — a minor, bounded jitter, not a functional failure.
- **No debounce or request-cancellation on conversation search.** `ConversationsListPage`'s search fetches on every keystroke with no `AbortController`; if an earlier keystroke's request resolves after a later one's (possible under network/DB jitter), the stale response can briefly overwrite newer results until the next keystroke corrects it. Consistent with the rest of the codebase, which uses no debouncing anywhere.
- **`ContactResolver.resolve()` has a narrow, pre-existing lazy-reload race** (`analytics/backend/contacts.py`) unrelated to the concurrency fix in this build — not exercised by normal usage since `resolver.load()` completes fully at startup before requests are served.
- **`ConversationDetailPage`'s volume chart flickers empty on granularity toggle; `OverviewPage`'s does not.** Both effects share the same stale-response guard, but `ConversationDetailPage` also resets `volume`/`volumeError` on every effect run (needed to clear stale data when navigating between conversations), which incidentally clears the chart on a granularity change too. Cosmetic only.
