import os

from backend.parser import parse_conversation as pc

RAW_EXPORT_DIR = "backend/parser/raw_export/long"
REGISTRY_PATH = "backend/parser/data/participant_registry.json"

def main():
    pc.load_participant_registry(REGISTRY_PATH)
    print(f"Registry loaded: {len(pc.participants)} known participant(s)")

    files = os.listdir(RAW_EXPORT_DIR)
    files.sort()
    print(f"Found {len(files)} conversation export(s) to parse")

    conversations = []
    for file in files:
        if file[-5:] != ".html":
            continue

        conversation = pc.parse_conversation(os.path.join(RAW_EXPORT_DIR, file))
        conversations.append(conversation)

        #SAVE CONVERSATION IN STORAGE HERE

    pc.save_participant_registry(REGISTRY_PATH)
    print(f"Registry saved: {len(pc.participants)} known participant(s)")

    return conversations


if __name__ == "__main__":
    main()
