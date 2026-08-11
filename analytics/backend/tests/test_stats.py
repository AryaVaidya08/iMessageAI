import pytest

from services.stats import (
    MessageEvent,
    TapbackEvent,
    bucket_volume,
    median_reply_seconds,
    tapbacks_given,
    tapbacks_received,
    top_emojis,
    top_words,
)


def test_median_reply_seconds_basic_transition():
    events = [
        MessageEvent("a", "2024-01-01T09:00:00"),
        MessageEvent("b", "2024-01-01T09:05:00"),
    ]
    result = median_reply_seconds(events)
    assert result["b"] == 300.0
    assert result["a"] is None


def test_median_reply_seconds_consecutive_same_sender_not_counted():
    events = [
        MessageEvent("a", "2024-01-01T09:00:00"),
        MessageEvent("a", "2024-01-01T09:01:00"),
        MessageEvent("b", "2024-01-01T09:10:00"),
    ]
    result = median_reply_seconds(events)
    assert result["b"] == 540.0
    assert result["a"] is None


def test_median_reply_seconds_uses_median_not_mean():
    events = [
        MessageEvent("b", "2024-01-01T09:00:00"),
        MessageEvent("a", "2024-01-01T09:01:00"),  # a replies to b: 60s
        MessageEvent("b", "2024-01-01T09:02:00"),
        MessageEvent("a", "2024-01-01T09:04:00"),  # a replies to b: 120s
        MessageEvent("b", "2024-01-01T09:06:00"),
        MessageEvent("a", "2024-02-01T09:06:00"),  # a replies to b: huge outlier gap
    ]
    result = median_reply_seconds(events)
    assert result["a"] == 120.0


def test_median_reply_seconds_all_same_sender_returns_none():
    events = [
        MessageEvent("a", "2024-01-01T09:00:00"),
        MessageEvent("a", "2024-01-01T09:01:00"),
        MessageEvent("a", "2024-01-01T09:02:00"),
    ]
    result = median_reply_seconds(events)
    assert result == {"a": None}


def test_median_reply_seconds_empty_list_returns_empty_dict():
    assert median_reply_seconds([]) == {}


def test_bucket_volume_day_passthrough():
    day_counts = [("2024-01-01", 5), ("2024-01-02", 3)]
    assert bucket_volume(day_counts, "day") == day_counts


def test_bucket_volume_week_groups_by_monday():
    day_counts = [("2024-01-01", 5), ("2024-01-02", 3), ("2024-01-08", 2)]
    # 2024-01-01 is a Monday
    assert bucket_volume(day_counts, "week") == [("2024-01-01", 8), ("2024-01-08", 2)]


def test_bucket_volume_month_groups_by_year_month():
    day_counts = [("2024-01-31", 5), ("2024-02-01", 3)]
    assert bucket_volume(day_counts, "month") == [("2024-01", 5), ("2024-02", 3)]


def test_bucket_volume_unknown_granularity_raises():
    with pytest.raises(ValueError):
        bucket_volume([("2024-01-01", 1)], "year")


def test_bucket_volume_empty_day_counts_returns_empty():
    assert bucket_volume([], "day") == []
    assert bucket_volume([], "week") == []
    assert bucket_volume([], "month") == []


def test_median_reply_seconds_three_senders():
    events = [
        MessageEvent("a", "2024-03-01T09:00:00"),
        MessageEvent("b", "2024-03-01T09:04:00"),  # b replies to a: 240s
        MessageEvent("c", "2024-03-01T09:09:00"),  # c replies to b: 300s
        MessageEvent("a", "2024-03-01T09:15:00"),  # a replies to c: 360s
        MessageEvent("b", "2024-03-01T09:25:00"),  # b replies to a: 600s
    ]
    result = median_reply_seconds(events)
    assert result["a"] == 360.0
    assert result["c"] == 300.0
    # b has two qualifying replies (240s and 600s); median of two is their mean.
    assert result["b"] == 420.0


def test_bucket_volume_week_spans_year_boundary():
    # 2024-12-30 is a Monday; its week runs through 2025-01-05.
    day_counts = [("2024-12-30", 4), ("2025-01-01", 6), ("2025-01-06", 7)]
    assert bucket_volume(day_counts, "week") == [("2024-12-30", 10), ("2025-01-06", 7)]


def test_median_reply_seconds_raises_on_unsorted_input():
    events = [
        MessageEvent("a", "2024-01-01T09:05:00"),
        MessageEvent("b", "2024-01-01T09:00:00"),
    ]
    with pytest.raises(ValueError):
        median_reply_seconds(events)


def test_median_reply_seconds_single_message_returns_none():
    events = [MessageEvent("a", "2024-01-01T09:00:00")]
    assert median_reply_seconds(events) == {"a": None}


def test_median_reply_seconds_even_number_of_deltas_averages():
    events = [
        MessageEvent("a", "2024-01-01T09:00:00"),
        MessageEvent("b", "2024-01-01T09:01:00"),  # b replies to a: 60s
        MessageEvent("a", "2024-01-01T09:02:00"),
        MessageEvent("b", "2024-01-01T09:05:00"),  # b replies to a: 180s
    ]
    result = median_reply_seconds(events)
    # median of [60, 180] is their mean, 120.0.
    assert result["b"] == 120.0


def test_top_words_filters_stopwords_and_short_tokens():
    texts = ["the cat sat on the mat", "a cat is a cat"]
    words = dict(top_words(texts, limit=5))
    assert words["cat"] == 3
    assert "the" not in words
    assert "on" not in words
    assert "is" not in words
    assert "a" not in words


def test_top_words_case_insensitive():
    texts = ["Hello hello HELLO"]
    assert dict(top_words(texts, limit=5))["hello"] == 3


def test_top_words_respects_limit():
    texts = ["apple banana cherry date elderberry fig grape"]
    assert len(top_words(texts, limit=3)) == 3


def test_top_words_empty_texts_returns_empty_list():
    assert top_words([], limit=5) == []


def test_top_words_ignores_numbers_and_punctuation_only_text():
    texts = ["123 456!! ... --- 42"]
    assert top_words(texts, limit=5) == []


def test_top_words_handles_curly_apostrophe_contractions():
    # iOS autocorrect defaults to curly apostrophes (U+2019), e.g. "don’t".
    texts = ["I don’t understand if that’s right", "coffee coffee coffee"]
    words = dict(top_words(texts, limit=10))
    assert "don" not in words
    assert "t" not in words
    assert "that" not in words
    assert "s" not in words
    assert words["coffee"] == 3
    assert words["understand"] == 1
    assert words["right"] == 1


def test_top_words_handles_straight_apostrophe_contractions():
    texts = ["I don't understand if that's right", "coffee coffee coffee"]
    words = dict(top_words(texts, limit=10))
    assert "don" not in words
    assert "t" not in words
    assert "that" not in words
    assert "s" not in words
    assert words["coffee"] == 3
    assert words["understand"] == 1
    assert words["right"] == 1


def test_top_emojis_counts_occurrences():
    texts = ["nice 🔥🔥", "so 🔥 cool 😂"]
    counts = dict(top_emojis(texts, limit=5))
    assert counts["🔥"] == 3
    assert counts["😂"] == 1


def test_top_emojis_empty_text_returns_empty():
    assert top_emojis([""], limit=5) == []


def test_top_emojis_handles_zwj_and_skin_tone_sequences():
    # Real data contains multi-codepoint emoji like skin-tone modifiers and
    # ZWJ sequences (e.g. "👩🏿‍🍼"), which must be counted as a single emoji,
    # not split into separate codepoints.
    texts = ["👩🏿‍🍼 congrats!", "👩🏿‍🍼 again"]
    counts = dict(top_emojis(texts, limit=5))
    assert counts["👩🏿‍🍼"] == 2


def test_top_emojis_respects_limit():
    texts = ["🔥😂🎉🥳🚀🎈"]
    assert len(top_emojis(texts, limit=3)) == 3


def test_top_emojis_normalizes_variation_selector():
    # emoji.emoji_list() returns the emoji exactly as matched in the source
    # text, with or without the invisible variation-selector-16 (U+FE0F)
    # codepoint, depending on how the original text was typed/copied. "❤"
    # (heart, no VS16) and "❤️" (heart + VS16) are visually
    # near-identical and must be counted as the same emoji.
    heart_no_vs16 = "❤"
    heart_with_vs16 = "❤️"
    texts = [f"I {heart_no_vs16} you", f"{heart_with_vs16} love this"]
    counts = dict(top_emojis(texts, limit=5))
    assert counts == {heart_no_vs16: 2}


def test_tapbacks_given_counts_by_action():
    events = [
        TapbackEvent("p1", "p2", "Liked"),
        TapbackEvent("p1", "p2", "Liked"),
        TapbackEvent("p1", "p3", "Loved"),
        TapbackEvent("p2", "p1", "Liked"),
    ]
    assert tapbacks_given(events, "p1") == [("Liked", 2), ("Loved", 1)]


def test_tapbacks_received_counts_by_action():
    events = [
        TapbackEvent("p1", "p2", "Liked"),
        TapbackEvent("p3", "p2", "Liked"),
        TapbackEvent("p1", "p3", "Loved"),
    ]
    assert tapbacks_received(events, "p2") == [("Liked", 2)]


def test_tapbacks_given_participant_with_no_tapbacks_returns_empty():
    events = [
        TapbackEvent("p1", "p2", "Liked"),
        TapbackEvent("p2", "p1", "Loved"),
    ]
    assert tapbacks_given(events, "p3") == []


def test_tapbacks_given_and_received_are_independent_for_same_participant():
    # A participant can appear as both reactor and target across different
    # events; given/received must each reflect only their own perspective,
    # not conflate reactor-side and target-side events for the same person.
    events = [
        TapbackEvent("p1", "p2", "Liked"),  # p1 reacts to p2 -> given for p1
        TapbackEvent("p2", "p1", "Loved"),  # p2 reacts to p1 -> received for p1
        TapbackEvent("p2", "p1", "Loved"),
    ]
    assert tapbacks_given(events, "p1") == [("Liked", 1)]
    assert tapbacks_received(events, "p1") == [("Loved", 2)]


def test_tapbacks_given_respects_limit():
    events = [
        TapbackEvent("p1", "p2", "Liked"),
        TapbackEvent("p1", "p2", "Liked"),
        TapbackEvent("p1", "p2", "Loved"),
        TapbackEvent("p1", "p2", "Laughed"),
    ]
    assert len(tapbacks_given(events, "p1", limit=2)) == 2
