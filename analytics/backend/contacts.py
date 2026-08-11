#Mirrors the approach used by imessage-exporter's contacts.rs: https://github.com/ReagentX/imessage-exporter

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path


ADDRESSBOOK_SOURCES_DIR = Path(
    "~/Library/Application Support/AddressBook/Sources"
).expanduser()

# Legacy single-file location (older macOS versions, or non-Sources setups)
ADDRESSBOOK_LEGACY_PATH = Path(
    "~/Library/Application Support/AddressBook/AddressBook-v22.abcddb"
).expanduser()


@dataclass(frozen=True)
class ContactRecord:
    full_name: str
    phones: tuple[str, ...]
    emails: tuple[str, ...]


def find_addressbook_dbs() -> list[Path]:
    """Locate all AddressBook-v22.abcddb files on disk."""
    dbs: list[Path] = []

    if ADDRESSBOOK_SOURCES_DIR.is_dir():
        for source_dir in ADDRESSBOOK_SOURCES_DIR.iterdir():
            candidate = source_dir / "AddressBook-v22.abcddb"
            if candidate.exists():
                dbs.append(candidate)

    if ADDRESSBOOK_LEGACY_PATH.exists():
        dbs.append(ADDRESSBOOK_LEGACY_PATH)

    return dbs


def normalize_phone(raw: str) -> str:
    """Strip formatting, keep last 10 digits (US-centric; adjust if needed)."""
    digits = re.sub(r"\D", "", raw)
    return digits[-10:] if len(digits) >= 10 else digits


def normalize_email(raw: str) -> str:
    return raw.strip().lower()


def _read_one_db(db_path: Path) -> list[ContactRecord]:
    """Read contacts from a single AddressBook-v22.abcddb file, read-only."""
    uri = f"file:{db_path}?mode=ro"
    records: list[ContactRecord] = []

    with sqlite3.connect(uri, uri=True) as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        cur.execute(
            """
            SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION
            FROM ZABCDRECORD
            """
        )
        people = {
            row["Z_PK"]: (row["ZFIRSTNAME"], row["ZLASTNAME"], row["ZORGANIZATION"])
            for row in cur.fetchall()
        }

        phones_by_owner: dict[int, list[str]] = {}
        cur.execute("SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER")
        for row in cur.fetchall():
            if row["ZFULLNUMBER"]:
                phones_by_owner.setdefault(row["ZOWNER"], []).append(row["ZFULLNUMBER"])

        emails_by_owner: dict[int, list[str]] = {}
        cur.execute("SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS")
        for row in cur.fetchall():
            if row["ZADDRESS"]:
                emails_by_owner.setdefault(row["ZOWNER"], []).append(row["ZADDRESS"])

        for pk, (first, last, org) in people.items():
            name_parts = [p for p in (first, last) if p]
            full_name = " ".join(name_parts) if name_parts else (org or "")
            if not full_name:
                continue
            records.append(
                ContactRecord(
                    full_name=full_name,
                    phones=tuple(phones_by_owner.get(pk, [])),
                    emails=tuple(emails_by_owner.get(pk, [])),
                )
            )

    return records


class ContactResolver:

    def __init__(self) -> None:
        self._by_phone: dict[str, str] = {}
        self._by_email: dict[str, str] = {}
        self._loaded = False

    def load(self) -> None:
        for db_path in find_addressbook_dbs():
            try:
                for record in _read_one_db(db_path):
                    for phone in record.phones:
                        self._by_phone.setdefault(normalize_phone(phone), record.full_name)
                    for email in record.emails:
                        self._by_email.setdefault(normalize_email(email), record.full_name)
            except sqlite3.OperationalError:
                # Likely missing Full Disk Access permission — skip, degrade gracefully
                continue
        self._loaded = True

    def resolve(self, handle: str) -> str | None:
        if not self._loaded:
            self.load()

        if "@" in handle:
            return self._by_email.get(normalize_email(handle))
        return self._by_phone.get(normalize_phone(handle))