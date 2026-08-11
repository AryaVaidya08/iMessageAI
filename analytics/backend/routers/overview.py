from fastapi import APIRouter, Depends, Query

from dependencies import get_db, get_resolver
from models import StatCards, TopConversationOut, TopConversationsResponse, VolumePoint, VolumeResponse
from services import queries, stats

router = APIRouter(prefix="/api/overview", tags=["overview"])


@router.get("", response_model=StatCards)
def get_overview(conn=Depends(get_db)):
    return queries.get_overview_stats(conn)


@router.get("/volume", response_model=VolumeResponse)
def get_overview_volume(
    granularity: str = Query("week", pattern="^(day|week|month)$"),
    conn=Depends(get_db),
):
    day_counts = queries.get_daily_message_counts(conn)
    bucketed = stats.bucket_volume(day_counts, granularity)
    return VolumeResponse(points=[VolumePoint(bucket=b, count=c) for b, c in bucketed])


@router.get("/top-conversations", response_model=TopConversationsResponse)
def get_top_conversations(
    limit: int = Query(10, ge=1, le=50),
    conn=Depends(get_db),
    resolver=Depends(get_resolver),
):
    items = queries.get_top_conversations(conn, resolver, limit)
    return TopConversationsResponse(items=[TopConversationOut(**i) for i in items])
