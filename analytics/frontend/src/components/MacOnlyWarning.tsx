import type { CSSProperties } from "react";

// iPadOS Safari reports itself as "MacIntel" but has a touch screen; real Macs report 0 touch points.
function isMac(): boolean {
  if (typeof navigator === "undefined") return true;
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform || navigator.platform || "";
  return /mac/i.test(platform) && navigator.maxTouchPoints <= 1;
}

const bar: CSSProperties = {
  padding: "12px 16px",
  background: "#FFF4CE",
  color: "#5C4300",
  borderBottom: "1px solid #E6C84A",
  fontSize: 14,
  lineHeight: 1.4,
  textAlign: "center",
};

export function MacOnlyWarning() {
  if (isMac()) return null;
  return (
    <div role="alert" style={bar}>
      <strong>⚠️ You can't use this on this device.</strong> This app reads the iMessage database stored on a Mac, so it
      only works on a MacBook (or other Mac). Please open it on a Mac to continue.
    </div>
  );
}
