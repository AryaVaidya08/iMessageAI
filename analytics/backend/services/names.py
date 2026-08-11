from dataclasses import dataclass


@dataclass(frozen=True)
class ResolvedParticipant:
    id: str
    handle: str
    display_name: str
    is_me: bool


def resolve_participant(id_: str, phone_num: str | None, email: str | None, is_me: bool, resolver) -> ResolvedParticipant:
    handle = phone_num or email or ""
    if is_me:
        name = "You"
    else:
        name = resolver.resolve(handle) if handle else None
        name = name or handle or "Unknown"
    return ResolvedParticipant(id=id_, handle=handle, display_name=name, is_me=bool(is_me))


def build_conversation_display_name(participants: list[ResolvedParticipant]) -> str:
    others = [p.display_name for p in participants if not p.is_me]
    if not others:
        return "You"
    if len(others) == 1:
        return f"You, {others[0]}"
    if len(others) <= 3:
        return "You, " + ", ".join(others)
    shown = others[:2]
    remaining = len(others) - 2
    return f"You, {', '.join(shown)} +{remaining} more"
