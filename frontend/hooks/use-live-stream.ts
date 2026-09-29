"use client";

import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createInvalidator, reconnectDelay, STREAM_EVENTS } from "@/lib/api/stream";

export type StreamState = "off" | "connecting" | "live" | "down";

// Subscribes to GET /api/stream. Each event refreshes only the data it changed. After a gap,
// everything is refreshed once to catch up. EventSource retries short drops itself; if it gives up
// (the server answered with an error instead of a stream), this reconnects with backoff.
export function useLiveStream(queryClient: QueryClient, enabled: boolean): StreamState {
  const [state, setState] = useState<StreamState>(enabled ? "connecting" : "off");

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    const push = createInvalidator((queryKey) => void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false }));
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let hadGap = false;
    let disposed = false;

    function connect() {
      source = new EventSource("/api/stream");
      source.onopen = () => {
        attempt = 0;
        setState("live");
        if (hadGap) void queryClient.invalidateQueries(undefined, { cancelRefetch: false });
        hadGap = false;
      };
      source.onerror = () => {
        hadGap = true;
        setState("down");
        if (source?.readyState === EventSource.CLOSED && !disposed) {
          source.close();
          retryTimer = setTimeout(connect, reconnectDelay(attempt));
          attempt += 1;
        }
      };
      for (const event of STREAM_EVENTS) source.addEventListener(event, () => push(event));
    }

    connect();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      source?.close();
    };
  }, [enabled, queryClient]);

  return enabled ? state : "off";
}
