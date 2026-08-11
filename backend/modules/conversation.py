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

    convo_name: str
    relationship_type: RelationshipType

    messages: list[Message] = field(default_factory=list)
    announcements : list[Announcement] = field(default_factory=list)