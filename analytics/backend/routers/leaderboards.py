from fastapi import APIRouter, Depends, Query

from dependencies import get_db, get_resolver
from models import (
    ArguedMessagesResponse,
    AttachmentLeaderboardResponse,
    SilenceLeaderboard,
    StreakLeaderboard,
    LovedMessagesResponse,
)
from services import queries

router = APIRouter(prefix="/api/leaderboards", tags=["leaderboards"])


@router.get("/attachments", response_model=AttachmentLeaderboardResponse)
def get_attachment_leaderboard(
    limit: int = Query(10, ge=1, le=50),
    conn=Depends(get_db),
    resolver=Depends(get_resolver),
):
    items = queries.get_attachment_leaderboard(conn, resolver, limit)
    return AttachmentLeaderboardResponse(items=items)


@router.get("/most-loved", response_model=LovedMessagesResponse)
def get_most_loved_messages(
    limit: int = Query(10, ge=1, le=50),
    conn=Depends(get_db),
    resolver=Depends(get_resolver),
):
    items = queries.get_most_tapbacked_messages(conn, resolver, limit)
    return LovedMessagesResponse(items=items)


@router.get("/most-argued", response_model=ArguedMessagesResponse)
def get_most_argued_messages(
    limit: int = Query(10, ge=1, le=50),
    conn=Depends(get_db),
    resolver=Depends(get_resolver),
):
    items = queries.get_most_replied_messages(conn, resolver, limit)
    return ArguedMessagesResponse(items=items)


@router.get("/streak", response_model=StreakLeaderboard | None)
def get_streak_leaderboard(conn=Depends(get_db), resolver=Depends(get_resolver)):
    result = queries.get_streak_leaderboard(conn, resolver)
    return StreakLeaderboard(**result) if result else None


@router.get("/silence", response_model=SilenceLeaderboard | None)
def get_silence_leaderboard(conn=Depends(get_db), resolver=Depends(get_resolver)):
    result = queries.get_silence_leaderboard(conn, resolver)
    return SilenceLeaderboard(**result) if result else None
