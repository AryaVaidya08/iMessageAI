import sqlite3
from contextlib import contextmanager
from typing import Iterator

from config import active_db_path


@contextmanager
def get_connection() -> Iterator[sqlite3.Connection]:
    # check_same_thread=False: FastAPI dispatches this generator dependency's
    # setup (before yield) and teardown (after yield, i.e. conn.close() below)
    # as separate calls into anyio's worker thread pool -- they are not
    # guaranteed to land on the same OS thread. Each request gets its own
    # fresh connection here (never shared across requests), so disabling the
    # same-thread check is safe: it only allows one connection's own
    # setup/teardown to span threads, not concurrent access from multiple
    # threads at once.
    # active_db_path() is re-resolved on every call (not cached at import
    # time) so a merge that creates the merged copy mid-session takes effect
    # on the very next request, with no restart.
    uri = f"file:{active_db_path()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()
