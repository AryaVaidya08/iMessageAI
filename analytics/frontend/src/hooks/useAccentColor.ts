import { useEffect, useState } from "react";

const STORAGE_KEY = "imessage-analytics-accent";
const DEFAULT_ACCENT = "#0A84FF";

function getStoredAccent(): string {
  return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_ACCENT;
}

export function useAccentColor() {
  const [accent, setAccentState] = useState<string>(getStoredAccent);

  useEffect(() => {
    document.documentElement.style.setProperty("--color-accent", accent);
  }, [accent]);

  const setAccent = (color: string) => {
    localStorage.setItem(STORAGE_KEY, color);
    setAccentState(color);
  };

  return { accent, setAccent };
}
