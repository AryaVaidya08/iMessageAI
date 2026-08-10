from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

@dataclass
class Announcement:

    annoucement_id: UUID

    datetime: datetime
    announcer_id: UUID
    action: str

    affected_id: UUID | None = None
    