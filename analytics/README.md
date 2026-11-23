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

Use a recent **Chromium-based browser** (Chrome, Edge, Brave). It needs Web Workers, WebAssembly and the origin-private file system (OPFS). Only Chrome was tested.

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
  batch, into a SQLite database (wa-sqlite) stored in the browser's origin-private file system (OPFS). The same worker serves
  the analytics between batches, so you can open Overview / Conversations / People while the import is still running; pages refresh as chats finish.
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

## Memory: measured, and what is NOT solved

Measured as the **physical footprint** (what macOS Activity Monitor / memory pressure use) of every process of a headless
Chrome test browser, as growth above an empty app (an empty app is 215 MB). `MEMORY_SIZE=100mb npm run test:e2e -- tests/e2e/memory.spec.ts`.

| import | peak growth | settles at | time |
|---|---|---|---|
| 100 MB chat.db (220k messages) | **+470 MB** | +305 MB | 27 s |
| 1 GB chat.db (2.19M messages) | **not met**: stopped by the 3 GB safety cap at 1.84M messages (84%): +2.7 GB (browser process 1.9 GB, renderer 0.9 GB) | n/a | 8 min to 84% |

**The target (flat memory, well under 500 MB growth at 1 GB, and a completed 1 GB import) is not met.**
Memory grows roughly linearly with the data written (about 0.9 MB per 1,000 messages in Chrome's browser process).

What the investigation established:
- Not the JS heap (a few MB) and not the workers' JS+wasm (about 40 MB, `measureUserAgentSpecificMemory`).
- Not reading chat.db: reading 613 MB through `FileReaderSync` slices leaves the browser process flat (+10 MB).
- IndexedDB was worse (browser process about 1.5x the data, and a 1 GB import stalled at 65%); the OPFS storage now used
  completes much further and is faster. In-memory journal + `synchronous=OFF` cut the 100 MB peak from +619 to +470 MB.
- Not fixed by: smaller pages/indexes (helped IndexedDB only), staging chat.db into OPFS (no gain), flushing on commit (no gain).
- An attempt to periodically close and reopen the OPFS handles to release the browser's memory hung in Chrome (disabled).
- RSS (shown by `ps`) overstates real memory by about 2x because it counts reclaimable file-backed pages.

Storage is one engine worker that owns the OPFS database (wa-sqlite `AccessHandlePoolVFS`, exclusive) and interleaves ingest
batches with query requests, so pages stay browsable during an import. Multi-connection VFSes (`OPFSCoopSyncVFS`) are not in
wa-sqlite 1.0.0. Realistic use today: databases up to a few hundred MB / ~1M messages.

## Legacy

`backend/` (imessage-exporter HTML scraping) and `analytics/backend/` (FastAPI) are the old single-user pipeline. They are
kept as the reference for the parity goldens and are no longer needed to run the site.
