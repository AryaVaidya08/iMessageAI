import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from contacts import ContactResolver
from routers import conversations, overview

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.resolver = ContactResolver()
    # AddressBook access can fail in many OS-specific ways (Full Disk Access
    # denial, missing file, corrupt .abcddb) beyond the sqlite3.OperationalError
    # contacts.py already handles internally -- startup must degrade to raw
    # phone/email handles, never crash the whole app.
    try:
        app.state.resolver.load()
    except Exception:
        logger.warning("ContactResolver.load() failed; contact names will fall back to raw handles", exc_info=True)
    yield


app = FastAPI(title="iMessage Analytics API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

app.include_router(overview.router)
app.include_router(conversations.router)
