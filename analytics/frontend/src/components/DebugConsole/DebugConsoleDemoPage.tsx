import { useMemo, useState } from "react";

import { DebugConsole } from "./DebugConsole";
import { makeFakeIngest } from "./fakeEvents";

/** Dev-only demo; routed in App.tsx behind import.meta.env.DEV. */
export default function DebugConsoleDemoPage() {
  const [run, setRun] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const subscribe = useMemo(() => makeFakeIngest({ chats: 12 }), [run]);
  return (
    <div style={{ padding: 24 }}>
      <h1>Debug console demo</h1>
      <p>Fake ingest stream driving the DebugConsole dock.</p>
      <button type="button" onClick={() => setRun((r) => r + 1)}>Restart</button>
      <DebugConsole subscribe={subscribe} />
    </div>
  );
}
