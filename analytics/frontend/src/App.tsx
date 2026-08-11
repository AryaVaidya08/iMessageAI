import { Route, Routes } from "react-router-dom";

import { TopNav } from "./components/TopNav";
import { ConversationDetailPage } from "./pages/ConversationDetailPage";
import { ConversationsListPage } from "./pages/ConversationsListPage";
import { LeaderboardsPage } from "./pages/LeaderboardsPage";
import { MergeContactsPage } from "./pages/MergeContactsPage";
import { OverviewPage } from "./pages/OverviewPage";

export default function App() {
  return (
    <>
      <TopNav />
      <main>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/conversations" element={<ConversationsListPage />} />
          <Route path="/conversations/:id" element={<ConversationDetailPage />} />
          <Route path="/leaderboards" element={<LeaderboardsPage />} />
          <Route path="/merge-contacts" element={<MergeContactsPage />} />
        </Routes>
      </main>
    </>
  );
}
