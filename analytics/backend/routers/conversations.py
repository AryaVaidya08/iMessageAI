from fastapi import APIRouter, Depends, HTTPException, Query

from dependencies import get_db, get_resolver
from models import (
    ConversationDetail,
    ConversationListResponse,
    MessagesPage,
    ParticipantStatsResponse,
    VolumePoint,
    VolumeResponse,
)
from services import queries, stats

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


@router.get("", response_model=ConversationListResponse)
def list_conversations(
    search: str | None = None,
    sort: str = Query("recent", pattern="^(recent|count)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    conn=Depends(get_db),
    resolver=Depends(get_resolver),
):
    result = queries.list_conversations(conn, resolver, search, sort, page, page_size)
    return ConversationListResponse(**result)


@router.get("/{conversation_id}", response_model=ConversationDetail)
def get_conversation(conversation_id: str, conn=Depends(get_db), resolver=Depends(get_resolver)):
    detail = queries.get_conversation_detail(conn, resolver, conversation_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    return ConversationDetail(**detail)


@router.get("/{conversation_id}/volume", response_model=VolumeResponse)
def get_conversation_volume(
    conversation_id: str,
    granularity: str = Query("week", pattern="^(day|week|month)$"),
    conn=Depends(get_db),
    resolver=Depends(get_resolver),
):
    participants = queries.get_conversation_participants_resolved(conn, resolver, conversation_id)
    if not participants:
        raise HTTPException(status_code=404, detail="conversation not found")
    day_counts = queries.get_daily_message_counts_for_conversation(conn, conversation_id)
    bucketed = stats.bucket_volume(day_counts, granularity)
    return VolumeResponse(points=[VolumePoint(bucket=b, count=c) for b, c in bucketed])


@router.get("/{conversation_id}/participant-stats", response_model=ParticipantStatsResponse)
def get_participant_stats(conversation_id: str, conn=Depends(get_db), resolver=Depends(get_resolver)):
    participants = queries.get_conversation_participants_resolved(conn, resolver, conversation_id)
    if not participants:
        raise HTTPException(status_code=404, detail="conversation not found")

    message_rows = queries.get_conversation_messages_for_stats(conn, conversation_id)
    tapback_rows = queries.get_conversation_tapback_events(conn, conversation_id)

    events = [stats.MessageEvent(sender_id=r["sender_id"], timestamp=r["timestamp"]) for r in message_rows]
    reply_seconds = stats.median_reply_seconds(events)

    texts_by_sender: dict[str, list[str]] = {}
    counts_by_sender: dict[str, int] = {}
    for r in message_rows:
        texts_by_sender.setdefault(r["sender_id"], []).append(r["text"])
        counts_by_sender[r["sender_id"]] = counts_by_sender.get(r["sender_id"], 0) + 1

    tapback_events = [
        stats.TapbackEvent(reactor_id=r["reactor_id"], target_sender_id=r["target_sender_id"], action=r["action"])
        for r in tapback_rows
    ]

    participants_out = []
    for pid, resolved in participants.items():
        texts = texts_by_sender.get(pid, [])
        participants_out.append({
            "participant_id": pid,
            "display_name": resolved.display_name,
            "message_count": counts_by_sender.get(pid, 0),
            "median_reply_seconds": reply_seconds.get(pid),
            "top_words": [{"word": w, "count": c} for w, c in stats.top_words(texts)],
            "top_emojis": [{"emoji": e, "count": c} for e, c in stats.top_emojis(texts)],
            "tapbacks_given": [{"action": a, "count": c} for a, c in stats.tapbacks_given(tapback_events, pid)],
            "tapbacks_received": [{"action": a, "count": c} for a, c in stats.tapbacks_received(tapback_events, pid)],
        })
    return ParticipantStatsResponse(participants=participants_out)


@router.get("/{conversation_id}/messages", response_model=MessagesPage)
def get_messages(
    conversation_id: str,
    before: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    conn=Depends(get_db),
    resolver=Depends(get_resolver),
):
    participants = queries.get_conversation_participants_resolved(conn, resolver, conversation_id)
    if not participants:
        raise HTTPException(status_code=404, detail="conversation not found")

    rows = queries.get_messages_page(conn, conversation_id, before, limit)
    message_ids = [r["id"] for r in rows]
    tapbacks_by_message = queries.get_tapbacks_for_messages(conn, message_ids, participants)

    items = []
    for r in rows:
        sender = participants.get(r["sender_id"])
        items.append({
            "id": r["id"],
            "sender_id": r["sender_id"],
            "sender_display_name": sender.display_name if sender else "Unknown",
            "timestamp": r["timestamp"],
            "text": r["text"],
            "has_attachment": bool(r["has_attachment"]),
            "has_sticker": bool(r["has_sticker"]),
            "reply_to": r["reply_to"],
            "tapbacks": tapbacks_by_message.get(r["id"], []),
        })

    next_cursor = rows[0]["id"] if len(rows) == limit else None
    return MessagesPage(items=items, next_cursor=next_cursor)
