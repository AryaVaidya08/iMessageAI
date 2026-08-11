from fastapi import APIRouter, Depends, Query

from dependencies import get_db, get_resolver
from models import (
    FastestReplyRelationship,
    HeatmapResponse,
    StatCards,
    TopConversationOut,
    TopConversationsResponse,
    VolumePoint,
    VolumeResponse,
)
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


@router.get("/heatmap", response_model=HeatmapResponse)
def get_overview_heatmap(conn=Depends(get_db)):
    cells = queries.get_global_dow_hour_counts(conn)
    return HeatmapResponse(grid=stats.build_heatmap_grid(cells))


@router.get("/fastest-reply-relationship", response_model=FastestReplyRelationship | None)
def get_fastest_reply_relationship(conn=Depends(get_db)):
    result = queries.get_fastest_reply_relationship_type(conn)
    return FastestReplyRelationship(**result) if result else None
