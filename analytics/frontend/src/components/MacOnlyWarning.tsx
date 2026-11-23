import type { CSSProperties } from "react";
import { FiSlash } from "react-icons/fi";

// iPadOS Safari reports itself as "MacIntel" but has a touch screen; real Macs report 0 touch points.
export function isMac(): boolean {
  if (typeof navigator === "undefined") return true;
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform || navigator.platform || "";
  return /mac/i.test(platform) && navigator.maxTouchPoints <= 1;
}

const page: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 16,
  padding: 24,
  textAlign: "center",
  background: "var(--color-bg, #F5F5F7)",
  color: "#FFCC00",
  fontFamily: "var(--font-ui, -apple-system, sans-serif)",
};

/** Full-page replacement for the whole app on devices that aren't a Mac. */
export function MacOnlyPage() {
  return (
    <div role="alert" style={page}>
      <FiSlash size={72} aria-hidden="true" />
      <h1 style={{ margin: 0, fontSize: 28 }}>iMessageAI only works on a Mac!</h1>
      <p style={{ margin: 0, maxWidth: 420, fontSize: 17, lineHeight: 1.5 }}>
        This app reads the iMessage database stored on a Mac, so it can't be used on this device. Please open this website on a MacBook so you can view your data!
      </p>
    </div>
  );
}
