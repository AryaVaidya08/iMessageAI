from services.names import ResolvedParticipant, build_conversation_display_name, resolve_participant


class FakeResolver:
    def __init__(self, mapping):
        self.mapping = mapping

    def resolve(self, handle):
        return self.mapping.get(handle)


def test_resolve_participant_uses_contact_name():
    resolver = FakeResolver({"+15551234567": "Jane Doe"})
    result = resolve_participant("p1", "+15551234567", None, False, resolver)
    assert result.display_name == "Jane Doe"


def test_resolve_participant_falls_back_to_handle():
    resolver = FakeResolver({})
    result = resolve_participant("p1", "+15551234567", None, False, resolver)
    assert result.display_name == "+15551234567"


def test_resolve_participant_is_me_returns_you():
    resolver = FakeResolver({})
    result = resolve_participant("me", "+15550000000", None, True, resolver)
    assert result.display_name == "You"


def test_display_name_one_on_one():
    participants = [
        ResolvedParticipant("me", "x", "You", True),
        ResolvedParticipant("p1", "y", "Jane", False),
    ]
    assert build_conversation_display_name(participants) == "You, Jane"


def test_display_name_small_group():
    participants = [
        ResolvedParticipant("me", "x", "You", True),
        ResolvedParticipant("p1", "a", "Jane", False),
        ResolvedParticipant("p2", "b", "Bob", False),
    ]
    assert build_conversation_display_name(participants) == "You, Jane, Bob"


def test_display_name_large_group_truncates():
    participants = [ResolvedParticipant("me", "x", "You", True)] + [
        ResolvedParticipant(f"p{i}", str(i), f"Person{i}", False) for i in range(5)
    ]
    assert build_conversation_display_name(participants) == "You, Person0, Person1 +3 more"


def test_display_name_three_others_does_not_truncate():
    participants = [ResolvedParticipant("me", "x", "You", True)] + [
        ResolvedParticipant(f"p{i}", str(i), f"Person{i}", False) for i in range(3)
    ]
    assert build_conversation_display_name(participants) == "You, Person0, Person1, Person2"


def test_display_name_four_others_truncates():
    participants = [ResolvedParticipant("me", "x", "You", True)] + [
        ResolvedParticipant(f"p{i}", str(i), f"Person{i}", False) for i in range(4)
    ]
    assert build_conversation_display_name(participants) == "You, Person0, Person1 +2 more"


def test_resolve_participant_no_handle_falls_back_to_unknown():
    resolver = FakeResolver({})
    result = resolve_participant("p1", None, None, False, resolver)
    assert result.handle == ""
    assert result.display_name == "Unknown"


def test_resolve_participant_uses_email_when_phone_missing():
    resolver = FakeResolver({"jane@example.com": "Jane Doe"})
    result = resolve_participant("p1", None, "jane@example.com", False, resolver)
    assert result.display_name == "Jane Doe"
