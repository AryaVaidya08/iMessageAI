from dataclasses import dataclass

@dataclass
class Participant:
    id: str
    
    phone_num: str | None = None
    email: str | None = None

    is_me: bool = False
    