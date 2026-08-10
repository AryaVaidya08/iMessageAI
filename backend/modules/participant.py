from dataclasses import dataclass
from uuid import UUID
@dataclass
class Participant:
    id: UUID
    
    phone_num: str | None = None
    email: str | None = None

    is_me: bool = False
    