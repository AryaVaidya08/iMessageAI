import os
from datetime import datetime

from tqdm import tqdm

from backend.parser import parse_conversation as pc
from backend.storage import get_connection, init_db, save_conversation

RAW_EXPORT_DIR = "backend/parser/raw_export/all"

REGISTRY_PATH = "backend/storage/data/participant_registry.json"
DB_PATH = "backend/storage/data/imessages_merged.db"

FAILURE_LOG_PATH = "backend/parser/data/failed_files.log"


def main():
    pc.load_participant_registry(REGISTRY_PATH)
    print(f"Registry loaded: {len(pc.participants)} known participant(s)")

    conn = get_connection(DB_PATH)
    init_db(conn)

    files = [f for f in os.listdir(RAW_EXPORT_DIR) if f.endswith(".html")]
    files.sort()

    conversations = []
    failures = []  # list of (file, error_message) tuples

    for file in tqdm(files, desc="Parsing conversations"):
        file_path = os.path.join(RAW_EXPORT_DIR, file)

        try:
            conversation = pc.parse_conversation(file_path)
            save_conversation(conn, conversation)
            conversations.append(conversation)
        except Exception as e:
            failures.append((file, f"{type(e).__name__}: {e}"))

    conn.close()

    pc.save_participant_registry(REGISTRY_PATH)
    print(f"Registry saved: {len(pc.participants)} known participant(s)")

    print(f"Parsed {len(conversations)} conversation(s), {len(failures)} failure(s)")
    if failures:
        for file, error_message in failures:
            print(f"FAILED: {file} -- {error_message}")
        write_failure_log(failures)
        print(f"Failure details written to {FAILURE_LOG_PATH}")

    return conversations


def write_failure_log(failures: list[tuple[str, str]]) -> None:
    os.makedirs(os.path.dirname(FAILURE_LOG_PATH), exist_ok=True)
    with open(FAILURE_LOG_PATH, "a", encoding="utf-8") as f:
        f.write(f"\n--- run at {datetime.now().isoformat()} ---\n")
        for file, error_message in failures:
            f.write(f"{file}\t{error_message}\n")


if __name__ == "__main__":
    main()