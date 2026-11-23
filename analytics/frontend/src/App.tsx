import { lazy, Suspense } from "react";
import { Route, Routes, useLocation } from "react-router-dom";

import { DebugConsole } from "./components/DebugConsole";
import { ImportBanner } from "./components/ImportBanner";
import { subscribeIngest } from "./engine/appState";
import { TopNav } from "./components/TopNav";
import { ConversationDetailPage } from "./pages/ConversationDetailPage";
import { ConversationsListPage } from "./pages/ConversationsListPage";
import { HomePage } from "./pages/HomePage";
import { MergePage } from "./pages/MergePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OverviewPage } from "./pages/OverviewPage";
import { PeopleListPage } from "./pages/PeopleListPage";
import { PersonDetailPage } from "./pages/PersonDetailPage";
import { SharePage } from "./pages/SharePage";

function DebugPage() {
  return (
    <div style={{ padding: "16px" }}>
      <h1>Import debug console</h1>
      <p>
        The console is docked at the bottom of the screen and shows the chat being parsed, per-chat and overall
        progress, memory use and a log. It stays open on this page.
      </p>
    </div>
  );
}

const DebugConsoleDemoPage = import.meta.env.DEV
  ? lazy(() => import("./components/DebugConsole/DebugConsoleDemoPage"))
  : null;

export default function App() {
  const { pathname } = useLocation();
  return (
    <>
      <TopNav />
      <ImportBanner />
      <main>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/conversations" element={<ConversationsListPage />} />
          <Route path="/conversations/:id" element={<ConversationDetailPage />} />
          <Route path="/people" element={<PeopleListPage />} />
          <Route path="/people/:id" element={<PersonDetailPage />} />
          <Route path="/merge" element={<MergePage />} />
          <Route path="/share" element={<SharePage />} />
          <Route path="/debug" element={<DebugPage />} />
          {DebugConsoleDemoPage && (
            <Route
              path="/debug-console-demo"
              element={
                <Suspense fallback={null}>
                  <DebugConsoleDemoPage />
                </Suspense>
              }
            />
          )}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
      <DebugConsole subscribe={subscribeIngest} forceOpen={pathname === "/debug"} />
    </>
  );
}
