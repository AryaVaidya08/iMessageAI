from typing import Iterator

from fastapi import Request

from contacts import ContactResolver
from db import get_connection


def get_db() -> Iterator:
    with get_connection() as conn:
        yield conn


def get_resolver(request: Request) -> ContactResolver:
    return request.app.state.resolver
