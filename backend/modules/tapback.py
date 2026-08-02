from dataclasses import dataclass

@dataclass
class Tapback:
    message_id: str
    reactor_id: str
    emoji: str