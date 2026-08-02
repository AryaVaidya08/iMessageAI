from dataclasses import dataclass

@dataclass
class Announcement:
    announcement_id: str
    announcer_id: str
    affected_id: str | None = None
    action: str