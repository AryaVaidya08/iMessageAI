import { useEffect, useRef, useState } from "react";
import { FiCopy, FiFile, FiFileText, FiImage } from "react-icons/fi";

import type { ConversationSummary, PersonSummary } from "../api/client";
import { ConversationPicker } from "../components/share/ConversationPicker";
import { PersonPicker } from "../components/share/PersonPicker";
import { ShareConversationBlock } from "../components/share/ShareConversationBlock";
import { ShareOverviewBlock } from "../components/share/ShareOverviewBlock";
import { SharePersonBlock } from "../components/share/SharePersonBlock";
import { fetchConversationShareData, fetchOverviewShareData, fetchPersonShareData } from "../lib/shareData";
import { copyShareText, downloadShareText, exportSharePdf, exportSharePng } from "../lib/shareExport";
import { buildShareText } from "../lib/shareText";
import type {
  ConvSection,
  ConversationShareData,
  FetchState,
  OverviewShareData,
  PersonSection,
  PersonShareData,
  SelectedConversation,
  SelectedPerson,
} from "../lib/shareTypes";
import styles from "./SharePage.module.css";

export function SharePage() {
  const [includeOverview, setIncludeOverview] = useState(false);
  const [overviewState, setOverviewState] = useState<FetchState<OverviewShareData> | null>(null);

  const [selectedConvs, setSelectedConvs] = useState<Map<string, SelectedConversation>>(new Map());
  const [convCache, setConvCache] = useState<Record<string, FetchState<ConversationShareData>>>({});

  const [selectedPeople, setSelectedPeople] = useState<Map<string, SelectedPerson>>(new Map());
  const [personCache, setPersonCache] = useState<Record<string, FetchState<PersonShareData>>>({});

  const [exporting, setExporting] = useState<"png" | "pdf" | null>(null);
  const [copied, setCopied] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!includeOverview || overviewState) return;
    setOverviewState({ status: "loading" });
    fetchOverviewShareData()
      .then((data) => setOverviewState({ status: "ready", data }))
      .catch((e) => setOverviewState({ status: "error", error: String(e) }));
  }, [includeOverview, overviewState]);

  useEffect(() => {
    for (const id of selectedConvs.keys()) {
      if (convCache[id]) continue;
      setConvCache((prev) => ({ ...prev, [id]: { status: "loading" } }));
      fetchConversationShareData(id)
        .then((data) => setConvCache((prev) => ({ ...prev, [id]: { status: "ready", data } })))
        .catch((e) => setConvCache((prev) => ({ ...prev, [id]: { status: "error", error: String(e) } })));
    }
  }, [selectedConvs, convCache]);

  useEffect(() => {
    for (const id of selectedPeople.keys()) {
      if (personCache[id]) continue;
      setPersonCache((prev) => ({ ...prev, [id]: { status: "loading" } }));
      fetchPersonShareData(id)
        .then((data) => setPersonCache((prev) => ({ ...prev, [id]: { status: "ready", data } })))
        .catch((e) => setPersonCache((prev) => ({ ...prev, [id]: { status: "error", error: String(e) } })));
    }
  }, [selectedPeople, personCache]);

  function addConversation(c: ConversationSummary) {
    setSelectedConvs((prev) => {
      if (prev.has(c.id)) return prev;
      const next = new Map(prev);
      next.set(c.id, {
        id: c.id,
        display_name: c.display_name,
        is_group_chat: c.is_group_chat,
        sections: new Set<ConvSection>(["overview", "stats", "leaderboard", "announcements"]),
      });
      return next;
    });
  }

  function removeConversation(id: string) {
    setSelectedConvs((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  function toggleConvSection(id: string, section: ConvSection) {
    setSelectedConvs((prev) => {
      const existing = prev.get(id);
      if (!existing) return prev;
      const sections = new Set(existing.sections);
      if (sections.has(section)) sections.delete(section);
      else sections.add(section);
      const next = new Map(prev);
      next.set(id, { ...existing, sections });
      return next;
    });
  }

  function addPerson(p: PersonSummary) {
    setSelectedPeople((prev) => {
      if (prev.has(p.id)) return prev;
      const next = new Map(prev);
      next.set(p.id, {
        id: p.id,
        display_name: p.display_name,
        sections: new Set<PersonSection>(["overview", "stats", "leaderboard"]),
      });
      return next;
    });
  }

  function removePerson(id: string) {
    setSelectedPeople((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  function togglePersonSection(id: string, section: PersonSection) {
    setSelectedPeople((prev) => {
      const existing = prev.get(id);
      if (!existing) return prev;
      const sections = new Set(existing.sections);
      if (sections.has(section)) sections.delete(section);
      else sections.add(section);
      const next = new Map(prev);
      next.set(id, { ...existing, sections });
      return next;
    });
  }

  const hasSelection = includeOverview || selectedConvs.size > 0 || selectedPeople.size > 0;
  const allReady =
    (!includeOverview || overviewState?.status === "ready") &&
    [...selectedConvs.keys()].every((id) => convCache[id]?.status === "ready") &&
    [...selectedPeople.keys()].every((id) => personCache[id]?.status === "ready");
  const canExport = hasSelection && allReady;

  function buildTextForExport(): string {
    return buildShareText({
      includeOverview,
      overviewData: overviewState?.status === "ready" ? overviewState.data : null,
      conversations: [...selectedConvs.values()]
        .map((selection) => {
          const state = convCache[selection.id];
          return state?.status === "ready" ? { selection, data: state.data } : null;
        })
        .filter((x): x is { selection: SelectedConversation; data: ConversationShareData } => x !== null),
      people: [...selectedPeople.values()]
        .map((selection) => {
          const state = personCache[selection.id];
          return state?.status === "ready" ? { selection, data: state.data } : null;
        })
        .filter((x): x is { selection: SelectedPerson; data: PersonShareData } => x !== null),
    });
  }

  async function handleCopyText() {
    await copyShareText(buildTextForExport());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleDownloadText() {
    downloadShareText(buildTextForExport());
  }

  async function handleExportPng() {
    if (!previewRef.current) return;
    setExporting("png");
    try {
      await exportSharePng(previewRef.current);
    } finally {
      setExporting(null);
    }
  }

  async function handleExportPdf() {
    if (!previewRef.current) return;
    setExporting("pdf");
    try {
      await exportSharePdf(previewRef.current);
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Share</h1>
      <p className={styles.subheading}>Pick what to include, then export it as text, a PNG image, or a PDF.</p>

      <div className={styles.layout}>
        <div className={styles.picker}>
          <label className={styles.overviewToggle}>
            <input type="checkbox" checked={includeOverview} onChange={(e) => setIncludeOverview(e.target.checked)} />
            <span className={styles.overviewToggleText}>
              <strong>Full Overview</strong>
              <span className={styles.pickerHint}>Global stats, volume, heatmap, top conversations</span>
            </span>
          </label>

          <ConversationPicker
            selected={selectedConvs}
            onAdd={addConversation}
            onRemove={removeConversation}
            onToggleSection={toggleConvSection}
          />

          <PersonPicker selected={selectedPeople} onAdd={addPerson} onRemove={removePerson} onToggleSection={togglePersonSection} />
        </div>

        <div className={styles.previewPane}>
          <div className={styles.exportBar}>
            <button type="button" className={styles.exportButton} disabled={!canExport} onClick={handleCopyText}>
              <FiCopy size={14} /> {copied ? "Copied!" : "Copy text"}
            </button>
            <button type="button" className={styles.exportButton} disabled={!canExport} onClick={handleDownloadText}>
              <FiFileText size={14} /> Text
            </button>
            <button type="button" className={styles.exportButton} disabled={!canExport || exporting !== null} onClick={handleExportPng}>
              <FiImage size={14} /> {exporting === "png" ? "Rendering…" : "PNG"}
            </button>
            <button type="button" className={styles.exportButton} disabled={!canExport || exporting !== null} onClick={handleExportPdf}>
              <FiFile size={14} /> {exporting === "pdf" ? "Rendering…" : "PDF"}
            </button>
          </div>

          {!hasSelection ? (
            <div className={styles.emptyPreview}>Select something on the left to build a preview.</div>
          ) : (
            <div className={styles.preview} ref={previewRef}>
              {includeOverview &&
                (overviewState?.status === "ready" ? (
                  <ShareOverviewBlock data={overviewState.data} />
                ) : overviewState?.status === "error" ? (
                  <div className={styles.loadingBlock}>Couldn't load overview: {overviewState.error}</div>
                ) : (
                  <div className={styles.loadingBlock}>Loading overview…</div>
                ))}

              {[...selectedConvs.values()].map((sel) => {
                const state = convCache[sel.id];
                if (state?.status === "ready") {
                  return <ShareConversationBlock key={sel.id} data={state.data} sections={sel.sections} />;
                }
                return (
                  <div key={sel.id} className={styles.loadingBlock}>
                    {state?.status === "error" ? `Couldn't load ${sel.display_name}: ${state.error}` : `Loading ${sel.display_name}…`}
                  </div>
                );
              })}

              {[...selectedPeople.values()].map((sel) => {
                const state = personCache[sel.id];
                if (state?.status === "ready") {
                  return <SharePersonBlock key={sel.id} data={state.data} sections={sel.sections} />;
                }
                return (
                  <div key={sel.id} className={styles.loadingBlock}>
                    {state?.status === "error" ? `Couldn't load ${sel.display_name}: ${state.error}` : `Loading ${sel.display_name}…`}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
