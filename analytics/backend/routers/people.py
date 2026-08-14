from fastapi import APIRouter, Depends, HTTPException, Query

from dependencies import get_db, get_resolver
from models import PeopleListResponse, PersonDetail, PersonOut
from services import queries

router = APIRouter(prefix="/api/people", tags=["people"])


@router.get("", response_model=PeopleListResponse)
def list_people(
    search: str | None = None,
    sort: str = Query("count", pattern="^(recent|count)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    conn=Depends(get_db),
    resolver=Depends(get_resolver),
):
    result = queries.list_people(conn, resolver, search, sort, page, page_size)
    return PeopleListResponse(**result)


@router.get("/{participant_id}", response_model=PersonOut)
def get_person(participant_id: str, conn=Depends(get_db), resolver=Depends(get_resolver)):
    resolved = queries.get_resolved_participant(conn, resolver, participant_id)
    if resolved is None:
        raise HTTPException(status_code=404, detail="person not found")
    return PersonOut(id=resolved.id, handle=resolved.handle, display_name=resolved.display_name)


@router.get("/{participant_id}/detail", response_model=PersonDetail)
def get_person_detail(participant_id: str, conn=Depends(get_db), resolver=Depends(get_resolver)):
    detail = queries.get_person_detail(conn, resolver, participant_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="person not found")
    return PersonDetail(**detail)
