from dataclasses import dataclass, field

from .participant import Participant
from .message import Message
from .relationship import RelationshipType
from .announcement import Announcement

@dataclass
class Conversation:
    id: str
    is_group_chat: bool
    
    participants: list[Participant]

    relationship_type: RelationshipType
    convo_name: str | None = None

    messages: list[Message] = field(default_factory=list)
    announcements : list[Announcement] = field(default_factory=list)