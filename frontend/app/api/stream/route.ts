// Relays the Go API's live stream (GET /api/stream, server-sent events) to the browser.
// Without this, the /api/* rewrite hands the stream to Next's gzip, which buffers it: the browser
// connects but receives nothing. `no-transform` tells the compressor to leave the stream alone.
// On AWS the load balancer routes /api/* straight to the Go API, so this only runs behind Next.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API_BASE = process.env.API_PROXY_TARGET ?? "http://api:8000";

export async function GET(req: Request): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${API_BASE}/api/stream`, {
      headers: { Accept: "text/event-stream" },
      cache: "no-store",
      signal: req.signal, // the browser leaving closes the upstream connection too
    });
  } catch (error) {
    console.error("stream relay: cannot reach the API", { error: String(error) });
    return Response.json({ error: { code: "NETWORK", message: "The live stream is unavailable." } }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return Response.json({ error: { code: `HTTP_${upstream.status}`, message: "The live stream is unavailable." } }, { status: 502 });
  }
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
