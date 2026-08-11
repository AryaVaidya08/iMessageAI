import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime
from statistics import median

import emoji as emoji_lib


@dataclass(frozen=True)
class MessageEvent:
    sender_id: str
    timestamp: str


def _check_sorted_ascending(messages: list[MessageEvent]) -> None:
    for prev, curr in zip(messages, messages[1:]):
        if curr.timestamp < prev.timestamp:
            # ISO-8601 timestamps sort correctly as plain strings, so this
            # O(n) check needs no datetime parsing.
            raise ValueError("messages must be sorted by timestamp ascending")


def _reply_deltas_by_sender(messages: list[MessageEvent]) -> dict[str, list[float]]:
    """
    Shared by median_reply_seconds and reply_time_histogram. Caller must
    have already validated `messages` is sorted ascending.

    Whenever the sender changes between two consecutive messages, the later
    message counts as a "reply" with delay = later.timestamp -
    earlier.timestamp. Returns, per replying sender, their list of reply
    delays in seconds, in message order.
    """
    # Parse each timestamp exactly once (instead of once as `curr` and again
    # as `prev` in the next iteration) since this loop runs over every
    # message in a 187K-message conversation.
    parsed = [(m.sender_id, datetime.fromisoformat(m.timestamp)) for m in messages]

    deltas: dict[str, list[float]] = defaultdict(list)
    for (prev_sender, prev_ts), (curr_sender, curr_ts) in zip(parsed, parsed[1:]):
        if curr_sender == prev_sender:
            continue
        deltas[curr_sender].append((curr_ts - prev_ts).total_seconds())
    return deltas


def median_reply_seconds(messages: list[MessageEvent]) -> dict[str, float | None]:
    """
    `messages` must be sorted by timestamp ascending (raises ValueError if
    not). Whenever the sender changes between two consecutive messages, the
    later message counts as a "reply" with delay = later.timestamp -
    earlier.timestamp. Returns, per sender, the median of their reply delays
    (None if they never had a qualifying reply). Median (not mean) so a
    single overnight gap doesn't dominate the figure.
    """
    _check_sorted_ascending(messages)
    deltas = _reply_deltas_by_sender(messages)

    # Separate pass over all senders (not just those seen as `curr` above) so
    # a sender who never triggers a reply transition -- e.g. someone who only
    # ever sent the very first message -- still gets a None entry.
    senders = {m.sender_id for m in messages}
    return {sender_id: (median(deltas[sender_id]) if deltas.get(sender_id) else None) for sender_id in senders}


def reply_deltas_seconds(messages: list[MessageEvent]) -> list[float]:
    """
    Pooled reply delay seconds (see median_reply_seconds for the definition
    of "reply"), regardless of which sender replied. `messages` must be
    sorted by timestamp ascending (raises ValueError if not). Used to
    compare responsiveness across groups of conversations (e.g. by
    relationship type) without caring which side did the replying.
    """
    _check_sorted_ascending(messages)
    return [d for deltas in _reply_deltas_by_sender(messages).values() for d in deltas]


HISTOGRAM_BUCKETS: list[tuple[str, float]] = [
    ("<1m", 60),
    ("1-5m", 300),
    ("5-30m", 1800),
    ("30m-2h", 7200),
    ("2-12h", 43200),
    ("12-24h", 86400),
    (">24h", float("inf")),
]


def reply_time_histogram(messages: list[MessageEvent]) -> dict[str, list[tuple[str, int]]]:
    """
    `messages` must be sorted by timestamp ascending (raises ValueError if
    not). Same reply-transition definition as median_reply_seconds. Buckets
    each reply delay into one of HISTOGRAM_BUCKETS and returns, per sender,
    counts in bucket order -- including zero-count buckets, so the frontend
    can render a stable set of bars without re-deriving bucket labels.
    """
    _check_sorted_ascending(messages)
    deltas = _reply_deltas_by_sender(messages)
    senders = {m.sender_id for m in messages}

    result: dict[str, list[tuple[str, int]]] = {}
    for sender_id in senders:
        counts = [0] * len(HISTOGRAM_BUCKETS)
        for delta in deltas.get(sender_id, []):
            for i, (_, upper) in enumerate(HISTOGRAM_BUCKETS):
                if delta < upper:
                    counts[i] += 1
                    break
        result[sender_id] = [(label, count) for (label, _), count in zip(HISTOGRAM_BUCKETS, counts)]
    return result


def fastest_reply_relationship_types(deltas_by_relationship: dict[str, list[float]]) -> list[tuple[str, float]]:
    """
    deltas_by_relationship: relationship_type -> pooled reply_deltas_seconds
    across every conversation of that type. Returns (relationship_type,
    median_seconds) sorted ascending (fastest replies first); relationship
    types with no qualifying replies are omitted.
    """
    return sorted(
        ((rel, median(deltas)) for rel, deltas in deltas_by_relationship.items() if deltas),
        key=lambda kv: kv[1],
    )


def gap_initiators(messages: list[MessageEvent], gap_threshold_seconds: float) -> dict[str, int]:
    """
    `messages` must be sorted by timestamp ascending (raises ValueError if
    not). Counts, per sender, how many times they sent the first message
    after a gap of at least `gap_threshold_seconds` since the previous
    message (from anyone, not just a sender-change). The very first message
    in the list never counts, since it has no previous message to have a
    gap from. Every sender present in `messages` gets an entry, 0 if they
    never broke a qualifying gap.
    """
    _check_sorted_ascending(messages)
    parsed = [(m.sender_id, datetime.fromisoformat(m.timestamp)) for m in messages]
    counts: dict[str, int] = {m.sender_id: 0 for m in messages}
    for (_prev_sender, prev_ts), (curr_sender, curr_ts) in zip(parsed, parsed[1:]):
        if (curr_ts - prev_ts).total_seconds() >= gap_threshold_seconds:
            counts[curr_sender] += 1
    return counts


LATE_NIGHT_HOURS = frozenset({23, 0, 1, 2, 3, 4})


def late_night_ratio(hours_by_sender: list[tuple[str, int]]) -> dict[str, float]:
    """
    hours_by_sender: (sender_id, hour) for every message, hour in 0-23 local
    time. Returns, per sender, the fraction of their messages sent during
    LATE_NIGHT_HOURS (11pm-4:59am).
    """
    totals: dict[str, int] = defaultdict(int)
    late: dict[str, int] = defaultdict(int)
    for sender_id, hour in hours_by_sender:
        totals[sender_id] += 1
        if hour in LATE_NIGHT_HOURS:
            late[sender_id] += 1
    return {sender_id: late[sender_id] / total for sender_id, total in totals.items()}


def build_heatmap_grid(cells: list[tuple[int, int, int]]) -> list[list[int]]:
    """
    cells: (day_of_week, hour, count), day_of_week 0=Sunday..6=Saturday
    (matching SQLite's strftime('%w')), hour 0-23. Returns a dense 7x24 grid
    (row=day_of_week, col=hour) with 0 for any (dow, hour) not present in
    cells.
    """
    grid = [[0] * 24 for _ in range(7)]
    for dow, hour, count in cells:
        grid[dow][hour] = count
    return grid


@dataclass(frozen=True)
class DayActivity:
    day: str  # 'YYYY-MM-DD'
    start_ts: str  # earliest message timestamp on this day
    end_ts: str  # latest message timestamp on this day


def longest_streak_days(days: list[DayActivity]) -> int:
    """
    `days` must be sorted ascending by day, one entry per calendar day that
    had at least one message. Returns the length, in days, of the longest
    run of consecutive calendar dates.
    """
    if not days:
        return 0
    best = streak = 1
    for prev, curr in zip(days, days[1:]):
        gap = (date.fromisoformat(curr.day) - date.fromisoformat(prev.day)).days
        streak = streak + 1 if gap == 1 else 1
        best = max(best, streak)
    return best


def longest_silence(days: list[DayActivity]) -> dict | None:
    """
    `days` must be sorted ascending by day. Returns the largest gap between
    the last message of one active day and the first message of the next
    active day, as {"before": end_ts, "after": start_ts, "gap_seconds": s}.
    None if fewer than 2 active days.

    This only considers gaps that cross a day boundary between two active
    days -- it can't detect a gap that happens to fall entirely within a
    single active day, since we only have that day's min/max timestamp, not
    its full message list. In practice the longest silence in a
    conversation is almost always a multi-day gap, so this trade-off avoids
    pulling every message (up to 187K in the largest conversation) just to
    find it.
    """
    if len(days) < 2:
        return None
    best_gap = -1.0
    best: tuple[str, str, float] | None = None
    for prev, curr in zip(days, days[1:]):
        gap = (datetime.fromisoformat(curr.start_ts) - datetime.fromisoformat(prev.end_ts)).total_seconds()
        if gap > best_gap:
            best_gap = gap
            best = (prev.end_ts, curr.start_ts, gap)
    assert best is not None
    before, after, gap_seconds = best
    return {"before": before, "after": after, "gap_seconds": gap_seconds}


def bucket_volume(day_counts: list[tuple[str, int]], granularity: str) -> list[tuple[str, int]]:
    """
    day_counts: [(YYYY-MM-DD, count), ...] sorted ascending by day.
    granularity: 'day' | 'week' | 'month'.
    Returns [(bucket_label, count), ...] ascending; bucket_label is the
    bucket's Monday (week) or day (day) as YYYY-MM-DD, or YYYY-MM (month).
    """
    if granularity == "day":
        return list(day_counts)
    if granularity not in ("week", "month"):
        raise ValueError(f"unknown granularity: {granularity}")

    buckets: dict[str, int] = defaultdict(int)
    for day_str, count in day_counts:
        d = date.fromisoformat(day_str)
        if granularity == "week":
            monday = date.fromordinal(d.toordinal() - d.weekday())
            key = monday.isoformat()
        else:
            key = f"{d.year:04d}-{d.month:02d}"
        buckets[key] += count
    return list(buckets.items())


STOPWORDS = frozenset({
    "a", "about", "above", "after", "again", "all", "am", "an", "and", "any", "are", "aren't", "as", "at",
    "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
    "can", "cant", "could", "couldn't",
    "did", "didn't", "do", "does", "doesn't", "doing", "don't", "down", "during",
    "each",
    "few", "for", "from", "further",
    "had", "hadn't", "has", "hasn't", "have", "haven't", "having", "he", "hed", "hell", "hes", "he's", "her",
    "here", "heres", "hers", "herself", "him", "himself", "his", "how", "hows", "how's",
    "i", "id", "ill", "im", "ive", "if", "in", "into", "is", "isn't", "it", "its", "it's", "itself",
    "just",
    "know", "let's", "like",
    "me", "more", "most", "mustn't", "my", "myself",
    "no", "nor", "not", "now",
    "of", "off", "on", "once", "only", "or", "other", "ought", "our", "ours", "ourselves", "out", "over", "own",
    "really",
    "same", "shan't", "she", "shed", "shell", "shes", "she's", "should", "shouldn't", "so", "some", "such",
    "than", "that", "thats", "that's", "the", "their", "theirs", "them", "themselves", "then", "there",
    "theres", "there's",
    "these", "they", "theyd", "theyll", "theyre", "theyve", "this", "those", "through", "to", "too",
    "under", "until", "up",
    "very",
    "was", "wasn't", "we", "wed", "well", "were", "weve", "weren't", "what", "whats", "what's", "when",
    "whens", "when's",
    "where", "wheres", "where's", "which", "while", "who", "whos", "who's", "whom", "why", "whys", "why's",
    "will", "with", "won't",
    "would", "wouldn't",
    "you", "youd", "youll", "youre", "youve", "your", "yours", "yourself", "yourselves",
    "dont", "didnt", "doesnt", "gonna", "wanna", "gotta", "yeah", "ok", "okay", "oh", "um", "uh", "hey",
    "lol", "lmao",
})

_WORD_RE = re.compile(r"[a-zA-Z']+")


def top_words(texts: list[str], limit: int = 15) -> list[tuple[str, int]]:
    counts: dict[str, int] = {}
    for text in texts:
        # iOS autocorrect defaults to the curly apostrophe (U+2019) rather than
        # the straight one (U+0027), e.g. "don't". Normalize to straight quotes
        # so STOPWORDS entries like "don't" match regardless of which
        # apostrophe character the source text used.
        normalized = text.lower().replace("’", "'")
        for match in _WORD_RE.finditer(normalized):
            word = match.group().strip("'")
            if len(word) <= 2 or word in STOPWORDS:
                continue
            counts[word] = counts.get(word, 0) + 1
    return sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:limit]


def top_emojis(texts: list[str], limit: int = 10) -> list[tuple[str, int]]:
    counts: dict[str, int] = {}
    for text in texts:
        for item in emoji_lib.emoji_list(text):
            e = item["emoji"].replace("️", "")
            counts[e] = counts.get(e, 0) + 1
    return sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:limit]


@dataclass(frozen=True)
class TapbackEvent:
    reactor_id: str
    target_sender_id: str
    action: str


def tapbacks_given(events: list[TapbackEvent], participant_id: str, limit: int = 10) -> list[tuple[str, int]]:
    counts: dict[str, int] = {}
    for e in events:
        if e.reactor_id == participant_id:
            counts[e.action] = counts.get(e.action, 0) + 1
    return sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:limit]


def tapbacks_received(events: list[TapbackEvent], participant_id: str, limit: int = 10) -> list[tuple[str, int]]:
    counts: dict[str, int] = {}
    for e in events:
        if e.target_sender_id == participant_id:
            counts[e.action] = counts.get(e.action, 0) + 1
    return sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:limit]


def best_streak_conversation(activity_by_conversation: dict[str, list[DayActivity]]) -> tuple[str, int] | None:
    """
    activity_by_conversation: conversation_id -> its DayActivity list (sorted
    ascending by day, as required by longest_streak_days). Returns the
    (conversation_id, streak_length) of whichever conversation has the
    longest consecutive-day streak, or None if there are no conversations.
    """
    best: tuple[str, int] | None = None
    for conv_id, days in activity_by_conversation.items():
        streak = longest_streak_days(days)
        if best is None or streak > best[1]:
            best = (conv_id, streak)
    return best


def best_silence_conversation(activity_by_conversation: dict[str, list[DayActivity]]) -> tuple[str, dict] | None:
    """
    activity_by_conversation: conversation_id -> its DayActivity list (sorted
    ascending by day, as required by longest_silence). Returns the
    (conversation_id, silence_dict) of whichever conversation has the
    largest gap between active days, or None if no conversation has at
    least 2 active days.
    """
    best: tuple[str, dict] | None = None
    for conv_id, days in activity_by_conversation.items():
        silence = longest_silence(days)
        if silence is None:
            continue
        if best is None or silence["gap_seconds"] > best[1]["gap_seconds"]:
            best = (conv_id, silence)
    return best


MEMBERSHIP_DELTAS = {"added person": 1, "removed person": -1, "left convo": -1}


def group_size_over_time(current_size: int, events: list[tuple[str, str]]) -> list[tuple[str, int]]:
    """
    current_size: the conversation's participant count right now (after all
    membership events have already happened). events: (datetime, action)
    pairs in chronological order, action being one of the announcements
    table's membership actions (see MEMBERSHIP_DELTAS; anything else is
    ignored). Walks backward from `current_size` to find the size before the
    first event, then forward again to produce one (datetime, size_after)
    point per event -- so the series is guaranteed to end at current_size.
    """
    net = sum(MEMBERSHIP_DELTAS.get(action, 0) for _, action in events)
    size = current_size - net
    points = []
    for dt, action in events:
        size += MEMBERSHIP_DELTAS.get(action, 0)
        points.append((dt, size))
    return points


def build_reply_graph(edges: list[tuple[str, str]]) -> list[tuple[str, str, int]]:
    """
    edges: (replier_sender_id, original_sender_id) pairs reconstructed from
    the reply_to chain. Excludes self-replies (someone replying to their own
    earlier message), which aren't a person-to-person relationship. Returns
    (replier, original, count) sorted by count descending.
    """
    counts = Counter((replier, original) for replier, original in edges if replier != original)
    return sorted(((replier, original, c) for (replier, original), c in counts.items()), key=lambda t: t[2], reverse=True)
