import { QueryClient } from "@tanstack/react-query";
import { isApiError } from "@/lib/api/http";

const NO_RETRY_CODES = new Set(["INVALID_RESPONSE", "INVALID_REQUEST", "MOCK_READONLY"]);

// Retrying cannot fix a client error or a malformed response; it can fix a blip, a 5xx or a timeout.
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error)) {
    if (NO_RETRY_CODES.has(error.code)) return false;
    if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) return false;
  }
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // Failed refetches keep the last good data on screen (degraded mode, brief section 11).
      queries: { staleTime: 2_000, retry: shouldRetry, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  });
}
