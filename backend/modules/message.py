from dataclasses import dataclass, field
from datetime import datetime
from .tapback import Tapback

@dataclass
class Message:
    id: str
    sender_id: str
    timestamp: datetime

    text: str
    has_attachment: bool = False
    has_sticker: bool = False

    tapbacks: list[Tapback] = field(default_factory=list)

    reply_to: str | None = None