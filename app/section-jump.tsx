"use client";

import { useEffect } from "react";

// Dashboard sections can arrive after an RPC snapshot. A normal browser hash
// jump runs before that content exists, so retry only while a target is absent.
export default function SectionJump() {
  useEffect(() => {
    let observer: MutationObserver | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { observer?.disconnect(); if (timeout) clearTimeout(timeout); };
    const jump = () => {
      stop();
      let id: string;
      try { id = decodeURIComponent(window.location.hash.slice(1)); } catch { return; }
      if (!id) return;
      const find = () => {
        const target = document.getElementById(id);
        if (!target) return false;
        target.scrollIntoView({ block: "start", behavior: "instant" });
        stop(); return true;
      };
      if (find()) return;
      observer = new MutationObserver(find);
      observer.observe(document.body, { childList: true, subtree: true });
      timeout = setTimeout(stop, 90_000);
    };
    jump(); window.addEventListener("hashchange", jump);
    return () => { stop(); window.removeEventListener("hashchange", jump); };
  }, []);
  return null;
}
