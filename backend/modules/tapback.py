from dataclasses import dataclass
from uuid import UUID

@dataclass
class Tapback:
    reactor_id: UUID
    action: str
