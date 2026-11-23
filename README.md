# iMessage AI
<b><u>Goal:</u></b> Build an iMessage platform with 2 features that helps you understand and effortlessly reply to messages in your own tone!

## Features 
1. <b>Conversation Analytics</b>
- Analyze your conversation history
- Generate graphs, statistics, & insights 

2.  <b>Reply Bot</b>
- Generate replies that imitate my texting style
- Adapt to the conversation (significant other, parents, friends, etc.)

## Using the analytics app
The analytics app is a fully static site: upload your `chat.db` (and optionally AddressBook databases) and everything is parsed and analyzed in your browser. Nothing leaves your device. See [analytics/README.md](analytics/README.md) for finding your files on macOS, supported browsers, storage, incremental sync, deployment and the LEGACY FastAPI + imessage-exporter flow.

```bash
cd analytics/frontend && npm install && npm run dev   # http://localhost:5173
```

## Project History
- 8/2/26 - Setup project goals and structure repository
- 8/3/26 - Started message & annoucement parsing
- 8/5/26 - Completed participant logic for parsing
- 8/10/26 - Built SQLite storage system and polished parsing logic
- 8/11/26 - Developed analysis frontend to view messages and statistics

## Notes
- all .gitkeep files are temporary placeholders to retain the structure of the codebase
- Remove sharing locations thing due to a lot of breaking in my phone