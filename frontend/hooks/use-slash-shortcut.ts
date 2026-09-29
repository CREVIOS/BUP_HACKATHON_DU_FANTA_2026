"use client";

import { useEffect } from "react";

// "/" opens the assistant from anywhere, unless the user is already typing in a field.
export function useSlashShortcut(onTrigger: () => void) {
  useEffect(() => {
    function handle(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      onTrigger();
    }
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [onTrigger]);
}
