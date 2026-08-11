import os
from pathlib import Path

DB_PATH = Path(
    os.environ.get(
        "IMESSAGE_DB_PATH",
        str(Path(__file__).resolve().parent.parent.parent / "backend" / "storage" / "data" / "imessages.db"),
    )
)
