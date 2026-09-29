"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { createContext, useContext, useMemo, useState } from "react";
import { useLiveStream, type StreamState } from "@/hooks/use-live-stream";
import { createApi, type Api } from "@/lib/api/client";
import { createHttp } from "@/lib/api/http";
import { createQueryClient } from "@/lib/api/query-client";

interface FuelopsContext {
  api: Api;
  stream: StreamState;
  pollMs: number; // how often queries refetch on their own
}

const Context = createContext<FuelopsContext | null>(null);

const POLL_WHEN_STREAM_DOWN_MS = 4_000; // docs/API.md 3.1: poll while the stream is down
const SAFETY_POLL_MS = 30_000; // a slow safety net even while the stream is live

export function FuelopsProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  const [api] = useState(() => createApi(createHttp()));
  const stream = useLiveStream(queryClient, true);
  const pollMs = stream === "live" ? SAFETY_POLL_MS : POLL_WHEN_STREAM_DOWN_MS;
  const value = useMemo(() => ({ api, stream, pollMs }), [api, stream, pollMs]);

  return (
    <QueryClientProvider client={queryClient}>
      <Context.Provider value={value}>{children}</Context.Provider>
      <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
    </QueryClientProvider>
  );
}

export function useFuelopsContext(): FuelopsContext {
  const value = useContext(Context);
  if (!value) throw new Error("useFuelopsContext must be used inside <FuelopsProvider>");
  return value;
}
