"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { createContext, useContext, useMemo, useState } from "react";
import { useLiveStream, type StreamState } from "@/hooks/use-live-stream";
import { createApi, type Api } from "@/lib/api/client";
import { createHttp } from "@/lib/api/http";
import { mockAdapter } from "@/lib/api/mock-adapter";
import { createQueryClient } from "@/lib/api/query-client";

interface FuelopsContext {
  api: Api;
  mock: boolean;
  stream: StreamState;
  pollMs: number | false; // how often queries refetch on their own
}

const Context = createContext<FuelopsContext | null>(null);

const POLL_WHEN_STREAM_DOWN_MS = 4_000; // docs/API.md 3.1: poll while the stream is down
const SAFETY_POLL_MS = 30_000; // a slow safety net even while the stream is live

// One QueryClient and one API client per mode. Remount with a new `key` to switch live <-> mock,
// so cached live data can never show up in mock mode or the other way round.
export function FuelopsProvider({ mock, children }: { mock: boolean; children: React.ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  const [api] = useState(() => createApi(createHttp(mock ? mockAdapter : undefined)));
  const stream = useLiveStream(queryClient, !mock);
  const pollMs: number | false = mock ? false : stream === "live" ? SAFETY_POLL_MS : POLL_WHEN_STREAM_DOWN_MS;
  const value = useMemo(() => ({ api, mock, stream, pollMs }), [api, mock, stream, pollMs]);

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
