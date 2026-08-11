import { useEffect, useRef, useState } from "react";
import { FiDroplet } from "react-icons/fi";

import { useAccentColor } from "../hooks/useAccentColor";
import styles from "./AccentColorPicker.module.css";

const PRESETS = [
  "#0A84FF", // blue (default)
  "#5E5CE6", // indigo
  "#AF52DE", // purple
  "#FF375F", // pink
  "#FF453A", // red
  "#FF9F0A", // orange
  "#32D74B", // green
  "#64D2FF", // cyan
];

export function AccentColorPicker() {
  const { accent, setAccent } = useAccentColor();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);
  const isCustom = !PRESETS.some((p) => p.toLowerCase() === accent.toLowerCase());

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        aria-label="Choose site accent color"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.triggerSwatch} style={{ background: accent }} />
      </button>
      {open && (
        <div className={styles.panel} role="group" aria-label="Site accent color">
          <div className={styles.grid}>
            {PRESETS.map((color) => (
              <button
                key={color}
                type="button"
                className={styles.swatch}
                data-selected={accent.toLowerCase() === color.toLowerCase()}
                style={{ background: color }}
                aria-label={`Use accent color ${color}`}
                aria-pressed={accent.toLowerCase() === color.toLowerCase()}
                onClick={() => {
                  setAccent(color);
                  setOpen(false);
                }}
              />
            ))}
            <button
              type="button"
              className={styles.customSwatch}
              data-selected={isCustom}
              style={isCustom ? { background: accent } : undefined}
              aria-label="Pick a custom accent color"
              aria-pressed={isCustom}
              onClick={() => customInputRef.current?.click()}
            >
              {!isCustom && <FiDroplet />}
            </button>
          </div>
          <input
            ref={customInputRef}
            type="color"
            className={styles.customInput}
            value={accent}
            onChange={(e) => setAccent(e.target.value)}
            aria-hidden="true"
            tabIndex={-1}
          />
        </div>
      )}
    </div>
  );
}
