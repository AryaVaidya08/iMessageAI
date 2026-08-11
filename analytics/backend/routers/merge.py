from fastapi import APIRouter, Depends, HTTPException

from dependencies import get_db, get_resolver
from models import MergeHistoryResponse, MergeParticipantsResponse, MergeRequest, MergeResponse
from services import merge

router = APIRouter(prefix="/api", tags=["merge"])


@router.get("/participants", response_model=MergeParticipantsResponse)
def list_participants(conn=Depends(get_db), resolver=Depends(get_resolver)):
    return MergeParticipantsResponse(participants=merge.list_participants(conn, resolver))


@router.get("/merge-history", response_model=MergeHistoryResponse)
def get_merge_history(conn=Depends(get_db)):
    return MergeHistoryResponse(items=merge.list_merge_history(conn))


@router.post("/merge", response_model=MergeResponse)
def merge_contacts(body: MergeRequest, resolver=Depends(get_resolver)):
    try:
        merge.merge_participants(body.keep_id, body.remove_id, resolver)
    except merge.MergeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return MergeResponse(ok=True, keep_id=body.keep_id, removed_id=body.remove_id)
