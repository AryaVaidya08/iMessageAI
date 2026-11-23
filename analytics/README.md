# iMessage Analytics (static, in-browser)

A fully static web app that analyzes your iMessage history. There is no server: you upload your `chat.db` (and optionally your AddressBook databases), and everything is parsed, stored and queried inside your browser.

> Status: this README describes the architecture from the approved plan (`src/engine/`). Engine pieces (SQLite WASM worker, ingest, query worker) are being built in parallel units; sections marked **status** note what may not have landed yet. The legacy FastAPI flow is documented at the bottom.

## Privacy

Nothing leaves your browser. There is no backend, no analytics beacon and no upload. Your files are read locally via the File API, parsed in Web Workers, and stored in the browser's Origin Private File System (OPFS) for this site's origin only. Hosting the site on a static host only serves the app code.

## Using it

1. Open the site (Chromium-based browser on desktop recommended).
2. On the home page, choose your `chat.db`, and optionally the AddressBook `.abcddb` files (for contact names).
3. Watch the debug console: current phase, current chat, per-chat progress and overall progress. Pages (Overview, Conversations, People, Merge, Share) are usable while parsing continues and refresh as data lands.

### Finding the files on macOS

- Messages: `~/Library/Messages/chat.db` (macOS hides `~/Library`; in the file picker press Cmd+Shift+G and paste the path, or copy the file to your Desktop first).
- Contacts: `~/Library/Application Support/AddressBook/AddressBook-v22.abcddb` plus any `~/Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb`.
- These folders are protected. Copying or reading them requires **Full Disk Access** for the app doing it (System Settings > Privacy & Security > Full Disk Access, enable Terminal/Finder-launching app). Copying the files first and uploading the copies is the simplest route.
- Work on a copy; the app only reads the file you pick and never modifies it.

## Supported browsers

Requires Web Workers, WebAssembly and OPFS (`navigator.storage.getDirectory`). Recent Chrome, Edge and Brave are recommended. Safari/Firefox support for the OPFS features used is partial; `index.html` shows an "unsupported browser" message when a prerequisite is missing.

## Storage, quotas and clearing data

Parsed data is stored as a SQLite database in OPFS, typically a fraction of the size of `chat.db`. The app checks `navigator.storage.estimate()` before ingest and warns if space looks insufficient. To clear data: use the in-app reset (if present in your build) or your browser's site settings (Chrome: Settings > Privacy > Site settings > View permissions and data stored across sites > this site > Delete data). Clearing site data removes all parsed data, merges and relationship edits.

## Incremental sync

The app records `last_rowid` and a fingerprint of the source `chat.db` in a `sync_state` table. On re-upload, only messages whose `ROWID` is new, or whose `date_edited` / `date_retracted` changed, are processed. Message identity is the stable chat.db `guid`; conversation ids are the chat guid and participant ids are normalized handles (E.164 phone numbers, else lowercase email), so ids are stable across syncs. Merges are stored as alias rows (`participant_alias`, `conversation_alias`) applied at read time, so they survive re-syncs.

## Architecture and memory design

- `src/engine/` holds the engine: SQLite WASM, an ingest worker that reads `chat.db` directly (no HTML export), and a query worker that serves the same routes as the former FastAPI API.
- `chat.db` is never loaded into memory: a custom VFS serves SQLite reads through `File.slice` with a small (<= 32 MB) LRU page cache.
- Ingest runs chat by chat in ROWID order, in batches of 2,000-5,000 messages, one transaction per batch.
- Analytics use SQL (`GROUP BY`, indexes, `LIMIT/OFFSET`), cache expensive aggregates in `summary_*` tables, virtualize long lists and downsample charts to about 1,000 points.
- Target: under about 500 MB heap on a 1 GB `chat.db`.

## Development

```bash
cd analytics/frontend
npm install
npm run dev       # http://localhost:5173
npm run build     # type-check + static build into dist/
npm run preview   # serve dist/ at http://localhost:4173
npm run test      # vitest (once the engine units add it)
```

Dev and preview servers send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. These make the page cross-origin isolated, which is **only required if the chosen SQLite VFS uses `SharedArrayBuffer`**. The OPFS sync-access-handle VFS in a dedicated worker does not need them. We send them regardless so either VFS works; if you rely on them, do not embed cross-origin resources that lack CORP/CORS headers.

The router is a `HashRouter`, so deep links (`/#/conversations/...`) work on any static host with no rewrite rules.

## Deploying as a static site

`npm run build` produces `analytics/frontend/dist/`; upload it anywhere.

- Base path: the build uses a relative base (`./`), so it works from subpaths such as GitHub Pages project sites. Set `VITE_BASE=/repo/` at build time for absolute URLs if you prefer.
- Headers (if you want cross-origin isolation in production): `public/_headers` (Netlify, Cloudflare Pages) is copied into `dist/`; `vercel.json` in `analytics/frontend` configures Vercel. GitHub Pages cannot set custom headers; this is fine unless the VFS requires `SharedArrayBuffer` (a service-worker shim such as coi-serviceworker is the usual workaround).
- Netlify: build `npm run build`, publish `dist`, base dir `analytics/frontend`. Vercel: root directory `analytics/frontend`. Serve over HTTPS (OPFS and workers need a secure context; `localhost` also qualifies).

---

# LEGACY: FastAPI + imessage-exporter flow

The original proof of concept still exists in the repo and is no longer the supported path. It reads `backend/storage/data/imessages.db`, produced by the Python parser in `backend/` from `imessage-exporter` HTML output.

```bash
cd analytics
./start_analysis.sh   # backend http://localhost:8000, legacy dev frontend http://localhost:5173
```

Backend by hand:

```bash
cd analytics/backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
python3 -m pytest tests/ -v
```

`IMESSAGE_DB_PATH=/path/to/imessages.db` overrides the database path. Contact resolution (`ContactResolver`) needs Full Disk Access for the terminal running the backend. The backend CORS configuration is specific to this legacy pairing and does not apply to the static app. Note that the frontend in this branch targets the in-browser engine, not the FastAPI API.

Known limitations of the legacy flow are tracked in git history of this file.
