"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { THEME_STORAGE_KEY as STORAGE_KEY } from "./theme";

const EVENT = "lido-theme-change";

function applyPreference() {
  let preference: string | null = null;
  try { preference = localStorage.getItem(STORAGE_KEY); } catch { /* Storage may be blocked. */ }
  const dark = preference === "dark" || (preference !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

function subscribe(listener: () => void) {
  const media = matchMedia("(prefers-color-scheme: dark)");
  const sync = () => { applyPreference(); listener(); };
  const storage = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) sync(); };
  sync();
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", storage);
  media.addEventListener("change", sync);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", storage);
    media.removeEventListener("change", sync);
  };
}

export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, () => document.documentElement.dataset.theme ?? "light", () => "light");
  const dark = theme === "dark";
  return <button className="theme-toggle" type="button" aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} title={dark ? "Light theme" : "Dark theme"} onClick={() => {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Still switch this page if storage is unavailable. */ }
    window.dispatchEvent(new Event(EVENT));
  }}>{dark ? <Sun size={16} /> : <Moon size={16} />}</button>;
}
