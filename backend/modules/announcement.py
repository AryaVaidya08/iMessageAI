from dataclasses import dataclass
from datetime import datetime

@dataclass
class Announcement:

    datetime: datetime
    announcer_id: str
    action: str

    affected_id: str | None = None
    