import type { NextConfig } from "next";

// In the container the operator UI proxies /api/* to the backend over the Docker
// network, so the browser only ever talks to this origin. Override with
// API_PROXY_TARGET for other topologies (defaults to the compose service name).
const apiTarget = process.env.API_PROXY_TARGET ?? "http://api:8000";

const nextConfig: NextConfig = {
  // Emit a self-contained server (.next/standalone/server.js) for a minimal
  // production image — see frontend/Dockerfile.
  output: "standalone",
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiTarget}/api/:path*` },
    ];
  },
};

export default nextConfig;
