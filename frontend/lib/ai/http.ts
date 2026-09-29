// Small helpers shared by the /ai route handlers.
export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

// The load balancer APPENDS the real peer address to x-forwarded-for, so the rightmost entry is the
// one a client cannot forge (the leftmost is whatever the client sent). One trusted proxy hop is
// assumed. Capped so a long header cannot bloat the rate limiter's key space.
export function clientKey(req: Request): string {
  const entries = req.headers.get("x-forwarded-for")?.split(",") ?? [];
  const last = entries[entries.length - 1]?.trim();
  return (last || "local").slice(0, 64);
}
