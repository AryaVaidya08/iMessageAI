import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime
from statistics import median

import emoji as emoji_lib


@dataclass(frozen=True)
class MessageEvent:
    sender_id: str
    timestamp: str


def median_reply_seconds(messages: list[MessageEvent]) -> dict[str, float | None]:
    """
    `messages` must be sorted by timestamp ascending (raises ValueError if
    not). Whenever the sender changes between two consecutive messages, the
    later message counts as a "reply" with delay = later.timestamp -
    earlier.timestamp. Returns, per sender, the median of their reply delays
    (None if they never had a qualifying reply). Median (not mean) so a
    single overnight gap doesn't dominate the figure.
    """
    for prev, curr in zip(messages, messages[1:]):
        if curr.timestamp < prev.timestamp:
            # ISO-8601 timestamps sort correctly as plain strings, so this
            # O(n) check needs no datetime parsing.
            raise ValueError("messages must be sorted by timestamp ascending")

    # Parse each timestamp exactly once (instead of once as `curr` and again
    # as `prev` in the next iteration) since this loop runs over every
    # message in a 187K-message conversation.
    parsed = [(m.sender_id, datetime.fromisoformat(m.timestamp)) for m in messages]

    deltas: dict[str, list[float]] = defaultdict(list)
    for (prev_sender, prev_ts), (curr_sender, curr_ts) in zip(parsed, parsed[1:]):
        if curr_sender == prev_sender:
            continue
        deltas[curr_sender].append((curr_ts - prev_ts).total_seconds())

    # Separate pass over all senders (not just those seen as `curr` above) so
    # a sender who never triggers a reply transition -- e.g. someone who only
    # ever sent the very first message -- still gets a None entry.
    senders = {m.sender_id for m in messages}
    return {sender_id: (median(deltas[sender_id]) if deltas.get(sender_id) else None) for sender_id in senders}


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
