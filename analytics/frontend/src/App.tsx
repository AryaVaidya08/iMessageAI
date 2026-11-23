import { Route, Routes } from "react-router-dom";

import { ImportBanner } from "./components/ImportBanner";
import { TopNav } from "./components/TopNav";
import { ConversationDetailPage } from "./pages/ConversationDetailPage";
import { ConversationsListPage } from "./pages/ConversationsListPage";
import { MergePage } from "./pages/MergePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OverviewPage } from "./pages/OverviewPage";
import { PeopleListPage } from "./pages/PeopleListPage";
import { PersonDetailPage } from "./pages/PersonDetailPage";
import { SharePage } from "./pages/SharePage";

export default function App() {
  return (
    <>
      <TopNav />
      <ImportBanner />
      <main>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/conversations" element={<ConversationsListPage />} />
          <Route path="/conversations/:id" element={<ConversationDetailPage />} />
          <Route path="/people" element={<PeopleListPage />} />
          <Route path="/people/:id" element={<PersonDetailPage />} />
          <Route path="/merge" element={<MergePage />} />
          <Route path="/share" element={<SharePage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </>
  );
}
