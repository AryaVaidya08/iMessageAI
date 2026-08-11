import pytest

from services.stats import (
    DayActivity,
    HISTOGRAM_BUCKETS,
    MessageEvent,
    TapbackEvent,
    best_silence_conversation,
    best_streak_conversation,
    build_heatmap_grid,
    build_reply_graph,
    bucket_volume,
    fastest_reply_relationship_types,
    gap_initiators,
    group_size_over_time,
    late_night_ratio,
    longest_silence,
    longest_streak_days,
    median_reply_seconds,
    reply_deltas_seconds,
    reply_time_histogram,
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


def test_reply_deltas_seconds_pools_across_senders():
    events = [
        MessageEvent("a", "2024-01-01T09:00:00"),
        MessageEvent("b", "2024-01-01T09:01:00"),  # 60s
        MessageEvent("a", "2024-01-01T09:03:00"),  # 120s
    ]
    assert sorted(reply_deltas_seconds(events)) == [60.0, 120.0]


def test_reply_deltas_seconds_raises_on_unsorted_input():
    events = [
        MessageEvent("a", "2024-01-01T09:05:00"),
        MessageEvent("b", "2024-01-01T09:00:00"),
    ]
    with pytest.raises(ValueError):
        reply_deltas_seconds(events)


def test_reply_time_histogram_buckets_by_delay():
    events = [
        MessageEvent("a", "2024-01-01T09:00:00"),
        MessageEvent("b", "2024-01-01T09:00:30"),  # 30s -> <1m
        MessageEvent("a", "2024-01-01T09:03:30"),  # 180s -> 1-5m
        MessageEvent("b", "2024-01-02T09:03:30"),  # 24h -> >24h
    ]
    result = reply_time_histogram(events)
    bucket_labels = [label for label, _ in HISTOGRAM_BUCKETS]
    assert [label for label, _ in result["b"]] == bucket_labels
    counts_b = dict(result["b"])
    assert counts_b["<1m"] == 1
    assert counts_b[">24h"] == 1  # exactly 86400s falls just past the 12-24h upper bound
    counts_a = dict(result["a"])
    assert counts_a["1-5m"] == 1


def test_reply_time_histogram_zero_count_buckets_present():
    events = [
        MessageEvent("a", "2024-01-01T09:00:00"),
        MessageEvent("b", "2024-01-01T09:00:30"),
    ]
    result = reply_time_histogram(events)
    assert dict(result["b"])["5-30m"] == 0


def test_reply_time_histogram_raises_on_unsorted_input():
    events = [
        MessageEvent("a", "2024-01-01T09:05:00"),
        MessageEvent("b", "2024-01-01T09:00:00"),
    ]
    with pytest.raises(ValueError):
        reply_time_histogram(events)


def test_fastest_reply_relationship_types_sorts_ascending():
    deltas = {"friend": [600.0, 200.0], "family": [30.0], "work": []}
    result = fastest_reply_relationship_types(deltas)
    assert result == [("family", 30.0), ("friend", 400.0)]


def test_fastest_reply_relationship_types_omits_empty():
    result = fastest_reply_relationship_types({"work": []})
    assert result == []


def test_gap_initiators_credits_sender_after_threshold():
    events = [
        MessageEvent("a", "2024-01-01T09:00:00"),
        MessageEvent("b", "2024-01-01T09:00:30"),  # 30s gap, below threshold
        MessageEvent("a", "2024-01-02T09:00:30"),  # ~24h gap, above threshold
    ]
    result = gap_initiators(events, gap_threshold_seconds=3600)
    assert result == {"a": 1, "b": 0}


def test_gap_initiators_first_message_never_counts():
    events = [MessageEvent("a", "2024-01-01T09:00:00")]
    assert gap_initiators(events, gap_threshold_seconds=1) == {"a": 0}


def test_gap_initiators_raises_on_unsorted_input():
    events = [
        MessageEvent("a", "2024-01-01T09:05:00"),
        MessageEvent("b", "2024-01-01T09:00:00"),
    ]
    with pytest.raises(ValueError):
        gap_initiators(events, gap_threshold_seconds=1)


def test_late_night_ratio_computes_fraction():
    hours = [("a", 23), ("a", 12), ("a", 2), ("b", 9)]
    result = late_night_ratio(hours)
    assert result["a"] == pytest.approx(2 / 3)
    assert result["b"] == 0.0


def test_late_night_ratio_boundary_hours():
    # 5am is NOT late-night; 4am and 23 (11pm) are.
    hours = [("a", 5), ("a", 4), ("a", 23)]
    result = late_night_ratio(hours)
    assert result["a"] == pytest.approx(2 / 3)


def test_build_heatmap_grid_fills_sparse_cells():
    grid = build_heatmap_grid([(0, 9, 5), (6, 23, 2)])
    assert len(grid) == 7
    assert all(len(row) == 24 for row in grid)
    assert grid[0][9] == 5
    assert grid[6][23] == 2
    assert grid[1][9] == 0


def test_build_heatmap_grid_empty_cells_all_zero():
    grid = build_heatmap_grid([])
    assert grid == [[0] * 24 for _ in range(7)]


def test_longest_streak_days_consecutive_run():
    days = [
        DayActivity("2024-01-01", "2024-01-01T09:00:00", "2024-01-01T10:00:00"),
        DayActivity("2024-01-02", "2024-01-02T09:00:00", "2024-01-02T10:00:00"),
        DayActivity("2024-01-03", "2024-01-03T09:00:00", "2024-01-03T10:00:00"),
        DayActivity("2024-01-10", "2024-01-10T09:00:00", "2024-01-10T10:00:00"),
    ]
    assert longest_streak_days(days) == 3


def test_longest_streak_days_empty_returns_zero():
    assert longest_streak_days([]) == 0


def test_longest_streak_days_single_day_returns_one():
    days = [DayActivity("2024-01-01", "2024-01-01T09:00:00", "2024-01-01T10:00:00")]
    assert longest_streak_days(days) == 1


def test_longest_streak_days_two_separate_runs_picks_longer():
    days = [
        DayActivity("2024-01-01", "x", "x"),
        DayActivity("2024-01-02", "x", "x"),
        DayActivity("2024-02-01", "x", "x"),
        DayActivity("2024-02-02", "x", "x"),
        DayActivity("2024-02-03", "x", "x"),
    ]
    assert longest_streak_days(days) == 3


def test_longest_silence_finds_largest_gap():
    days = [
        DayActivity("2024-01-01", "2024-01-01T09:00:00", "2024-01-01T23:00:00"),
        DayActivity("2024-01-02", "2024-01-02T00:05:00", "2024-01-02T10:00:00"),  # small gap after day1
        DayActivity("2024-02-01", "2024-02-01T08:00:00", "2024-02-01T09:00:00"),  # huge gap after day2
    ]
    result = longest_silence(days)
    assert result["before"] == "2024-01-02T10:00:00"
    assert result["after"] == "2024-02-01T08:00:00"
    # Jan 2 10:00 -> Feb 1 10:00 is exactly 30 days; Feb 1 08:00 is 2h earlier.
    assert result["gap_seconds"] == pytest.approx(30 * 24 * 3600 - 2 * 3600, abs=1)


def test_longest_silence_fewer_than_two_days_returns_none():
    assert longest_silence([]) is None
    assert longest_silence([DayActivity("2024-01-01", "x", "x")]) is None


def test_best_streak_conversation_picks_the_longer_one():
    activity = {
        "conv1": [
            DayActivity("2024-01-01", "x", "x"),
            DayActivity("2024-01-02", "x", "x"),
        ],
        "conv2": [
            DayActivity("2024-01-01", "x", "x"),
            DayActivity("2024-01-02", "x", "x"),
            DayActivity("2024-01-03", "x", "x"),
        ],
    }
    assert best_streak_conversation(activity) == ("conv2", 3)


def test_best_streak_conversation_empty_returns_none():
    assert best_streak_conversation({}) is None


def test_best_silence_conversation_picks_the_largest_gap():
    activity = {
        "conv1": [
            DayActivity("2024-01-01", "2024-01-01T09:00:00", "2024-01-01T10:00:00"),
            DayActivity("2024-01-02", "2024-01-02T09:00:00", "2024-01-02T10:00:00"),
        ],
        "conv2": [
            DayActivity("2024-01-01", "2024-01-01T09:00:00", "2024-01-01T10:00:00"),
            DayActivity("2024-03-01", "2024-03-01T09:00:00", "2024-03-01T10:00:00"),
        ],
        "conv3": [DayActivity("2024-01-01", "x", "x")],  # only 1 active day, no silence
    }
    conv_id, silence = best_silence_conversation(activity)
    assert conv_id == "conv2"
    assert silence["before"] == "2024-01-01T10:00:00"


def test_best_silence_conversation_no_eligible_conversation_returns_none():
    activity = {"conv1": [DayActivity("2024-01-01", "x", "x")]}
    assert best_silence_conversation(activity) is None


def test_group_size_over_time_ends_at_current_size():
    events = [
        ("2024-01-01T00:00:00", "added person"),
        ("2024-01-02T00:00:00", "added person"),
        ("2024-01-03T00:00:00", "removed person"),
    ]
    # net delta = +1 +1 -1 = +1, so size before the first event was 5 - 1 = 4.
    points = group_size_over_time(current_size=5, events=events)
    assert points[0] == ("2024-01-01T00:00:00", 5)  # 4 -> 5 after "added person"
    assert points[1] == ("2024-01-02T00:00:00", 6)  # 5 -> 6 after "added person"
    assert points[-1] == ("2024-01-03T00:00:00", 5)  # 6 -> 5 after "removed person"


def test_group_size_over_time_ignores_unknown_actions():
    events = [("2024-01-01T00:00:00", "renamed convo")]
    points = group_size_over_time(current_size=3, events=events)
    assert points == [("2024-01-01T00:00:00", 3)]


def test_group_size_over_time_no_events_returns_empty():
    assert group_size_over_time(current_size=3, events=[]) == []


def test_build_reply_graph_counts_and_sorts_by_weight():
    edges = [("a", "b"), ("a", "b"), ("c", "b"), ("b", "a")]
    graph = build_reply_graph(edges)
    assert graph[0] == ("a", "b", 2)
    assert ("c", "b", 1) in graph
    assert ("b", "a", 1) in graph


def test_build_reply_graph_excludes_self_replies():
    edges = [("a", "a"), ("a", "b")]
    graph = build_reply_graph(edges)
    assert graph == [("a", "b", 1)]
