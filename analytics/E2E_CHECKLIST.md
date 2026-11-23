# Click-through checklist (parity)

Run with the legacy backend (`analytics/start_analysis.sh`) until the in-browser engine lands, then with an uploaded fixture chat.db. With `VITE_FAKE_INGEST=1` the import banner can be exercised without the engine.

1. Overview `/`: stat cards, volume (day/week/month toggle), top conversations, heatmap, fastest-reply, records.
2. Conversations `/conversations`: search, sort (count/recent), pagination; open one.
3. Conversation detail: message viewer (before/after/around/date), search, tapbacks, replies, relationship-type edit, volume, participant stats, personality leaderboard, heatmap, streak/silence, group size, join/leave, leaderboard, reply graph.
4. People `/people`: search, sort recent/messages/conversations asc/desc; open a person (stats, leaderboard).
5. Merge `/merge`: merge two participants, merge two conversations, history lists both.
6. Share `/share`: choose Overview and a conversation; "Copy text" (paste to verify); "Export PNG" downloads; "Export PDF" opens print dialog showing only the card.
7. 404: `/does-not-exist` shows the not-found page; nav links work; theme toggle + accent picker persist.
8. Import banner: while ingest runs, every page shows "Still importing: N%" linking to the debug console, and Overview refreshes on data-changed.
9. Empty state: with no data every page renders without errors.
