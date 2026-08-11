import os
from pathlib import Path

DB_PATH = Path(
    os.environ.get(
        "IMESSAGE_DB_PATH",
        str(Path(__file__).resolve().parent.parent.parent / "backend" / "storage" / "data" / "imessages.db"),
    )
)

# Contact-merge writes go to a separate copy of DB_PATH, never to DB_PATH itself.
# Once this file exists, it becomes the active database everywhere (see db.py) --
# so a merge is visible immediately and further merges accumulate onto the same
# copy instead of creating new ones.
MERGED_DB_PATH = DB_PATH.parent / "imessages_contacts_merged.db"


def active_db_path() -> Path:
    return MERGED_DB_PATH if MERGED_DB_PATH.exists() else DB_PATH
