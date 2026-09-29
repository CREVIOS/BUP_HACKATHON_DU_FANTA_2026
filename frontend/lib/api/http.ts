import axios, { AxiosError, type AxiosAdapter, type AxiosInstance } from "axios";
import { getCredentials } from "@/lib/api/credentials";
import { errorEnvelopeSchema } from "@/lib/api/schemas";

const TIMEOUT_MS = 10_000;

// One error type for the whole UI. `code` is the API's code (UNSAFE, NOT_PROPOSED, ...) or one of
// ours: NETWORK, TIMEOUT, HTTP_<status>, INVALID_RESPONSE, INVALID_REQUEST.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError;

function toApiError(error: unknown): unknown {
  if (axios.isCancel(error) || !(error instanceof AxiosError)) return error; // let aborts propagate as-is
  if (error.code === AxiosError.ECONNABORTED || error.code === AxiosError.ETIMEDOUT) {
    return new ApiError(0, "TIMEOUT", "The server took too long to answer.");
  }
  const response = error.response;
  if (!response) return new ApiError(0, "NETWORK", "Cannot reach the server.");
  const envelope = errorEnvelopeSchema.safeParse(response.data);
  if (envelope.success) {
    const { code, message, details } = envelope.data.error;
    return new ApiError(response.status, code, message, details ?? []);
  }
  return new ApiError(response.status, `HTTP_${response.status}`, `The server answered ${response.status}.`);
}

// Same-origin: the browser calls /api/*, which Next rewrites (locally) or the ALB routes (AWS) to the Go API.
// `adapter` swaps the transport, which is how mock mode serves captured fixtures.
export function createHttp(adapter?: AxiosAdapter): AxiosInstance {
  const http = axios.create({
    timeout: TIMEOUT_MS,
    headers: { Accept: "application/json" },
    ...(adapter ? { adapter } : {}),
  });
  http.interceptors.request.use((config) => {
    const { token, actor } = getCredentials();
    if (token) config.headers.set("Authorization", `Bearer ${token}`);
    if (actor) config.headers.set("X-Actor", actor);
    return config;
  });
  http.interceptors.response.use(undefined, (error: unknown) => Promise.reject(toApiError(error)));
  return http;
}
