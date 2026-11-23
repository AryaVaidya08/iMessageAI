# iMessage Analytics (static, in-browser)

Explore your Messages history: volume, relationships, reply times, sentiment, leaderboards, shareable summaries.
**Everything runs inside your browser tab. There is no server: your files are never uploaded anywhere.**

## Run it

```bash
cd analytics/frontend
npm install
npm run dev          # http://localhost:5173
# or a static build you can host anywhere (GitHub Pages, Netlify, S3, ...)
npm run build        # -> dist/   (npm run preview to serve it)
```

Use a recent **Chromium-based browser** (Chrome, Edge, Brave). It needs Web Workers, WebAssembly and IndexedDB.

## What to upload

On the home page drop:

1. **chat.db** (required): `~/Library/Messages/chat.db`.
   Messages keeps recent messages in a write-ahead log, so for a complete import **quit Messages and copy
   `chat.db`, `chat.db-wal` and `chat.db-shm` together** and drop all three. Without the `-wal` the page warns you and you
   can still import (the newest messages are missing until you sync again with the `-wal`).
2. **Contacts** (optional, shows names instead of numbers): `~/Library/Application Support/AddressBook/AddressBook-v22.abcddb`
   plus every `Sources/*/AddressBook-v22.abcddb` (iCloud, Google, ...). Or choose the whole AddressBook folder.

macOS protects those folders: use Finder > Go to Folder (Cmd+Shift+G), or grant your browser Full Disk Access, or copy the
files to the Desktop first. The app only reads the files you choose.

### Try it with synthetic data (no personal files)

```bash
cd analytics/frontend
npm run make-fixtures                    # writes tests/.cache/ (git-ignored)
```

Then upload `tests/.cache/chat-small.db` (600 messages) or `tests/.cache/chat-100mb.db` (220k messages), and all
`.abcddb` files under `tests/.cache/addressbook/` (the main file and `Sources/*`).
`tests/.cache/chat-small-appended.db` is the same database plus 50 new messages, an edit and an unsend: use it to try
"Sync new messages".

## How it works

- **Direct SQLite read.** `chat.db` is read page by page straight from the file you picked (a read-only SQLite VFS over
  `File.slice` with a 32 MB cache), never loaded into memory. A copied `-wal` is replayed (committed frames only,
  checksums validated).
- **Streaming import, viewable while it runs.** An ingest worker parses chat by chat in ROWID order, one transaction per
  batch, into a SQLite database (wa-sqlite) stored in the browser's IndexedDB. A second worker serves the analytics, so you
  can open Overview / Conversations / People while the import is still running; pages refresh as chats finish.
- **Debug console.** The dock at the bottom shows the phase, the chat being parsed, per-chat and overall progress with ETA
  and throughput, and a log. `/debug` keeps it open.
- **Incremental sync.** Dropping a newer `chat.db` again processes only new messages (per-chat ROWID watermark), re-checks
  edited/unsent messages, and skips an unchanged file entirely.
- **Merges** (contacts and conversations) are alias rows applied at read time, so they survive later syncs.
- **Analytics** (the old FastAPI routes) are TypeScript route handlers in `src/engine/query/`, SQL-first with cached
  summary tables. They are checked against the legacy Python output (`npm run test:parity`, 92 cases).
- Data stays in your browser until you press **Delete all data** (or clear site data).

## Commands

| | |
|---|---|
| `npm test` | unit tests (vitest) |
| `PARITY_ENGINE=1 npx vitest run tests/parity.spec.ts` (`npm run test:parity`) | real pipeline vs the legacy Python goldens |
| `npm run test:e2e` | real-browser tests (system Chrome): upload, browse during import, all pages, sync, merge, WAL, delete |
| `MEMORY_SIZE=100mb npm run test:e2e -- tests/e2e/memory.spec.ts` | resident memory of the whole test browser during an import |

## Memory: measured, and what is not solved

Measured as the resident memory (RSS) of every process of a headless Chrome test browser (an empty app already uses ~720 MB):

| import | peak above empty app | notes |
|---|---|---|
| 100 MB chat.db (220k messages) | about +730 MB (renderer +560, browser/IndexedDB +160) | imports in ~20-35 s |
| 1 GB chat.db (2.19M messages) | **did not finish**: stalled at 1.43M messages with ~3.4 GB total (renderer ~0.9, browser/IndexedDB ~2.3) | cause not diagnosed |

The JS heap itself stays at a few MB and the workers' own JS+wasm memory is ~40 MB (Chrome `measureUserAgentSpecificMemory`);
the remainder is browser-internal (IndexedDB backing store, renderer allocations). **This does not meet the original
500 MB budget**, and large imports (1 GB chat.db, ~2.2M messages) use several GB of browser memory in this design. Memory
grows with the amount of imported data (the browser process that hosts IndexedDB). A real Messages database of a few hundred
thousand messages is in the 100 MB class above; a multi-GB one is not supported yet. Known next steps: find why the 1 GB
import stalls, and move storage off IndexedDB (OPFS) once a multi-connection VFS is available.

## Legacy

`backend/` (imessage-exporter HTML scraping) and `analytics/backend/` (FastAPI) are the old single-user pipeline. They are
kept as the reference for the parity goldens and are no longer needed to run the site.
