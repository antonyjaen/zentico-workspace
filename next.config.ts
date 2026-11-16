import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // Build identifier inlined into server and client bundles; VersionWatcher compares them to
  // offer a reload when a tab outlives a deploy (its server-action ids would be stale).
  env: { NEXT_PUBLIC_BUILD_ID: process.env.BUILD_ID || String(Date.now()) },
  output: "standalone",
  // GET /bridge.mjs serves this file (read with fs, which tracing can't see).
  outputFileTracingIncludes: { "/bridge.mjs": ["./tools/zentico-bridge.mjs"] },
  poweredByHeader: false,
  // Composed messages (with quoted originals) can exceed the 1 MB default.
  experimental: {
    serverActions: { bodySizeLimit: "10mb" },
    // Middleware buffers request bodies and truncates them at 10 MB by default, which
    // silently corrupted Drive uploads and large mail attachments.
    middlewareClientMaxBodySize: "200mb",
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
