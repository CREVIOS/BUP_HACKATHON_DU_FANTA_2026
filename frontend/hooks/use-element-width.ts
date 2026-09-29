"use client";

import { useEffect, useRef, useState } from "react";

// The rendered width of an element, updated on resize. Lets an SVG chart draw at real pixel size so
// its text stays the same size at any width (a scaled viewBox would enlarge text on wide screens).
export function useElementWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}
