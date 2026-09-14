import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "prisma"],
  // Replay mode reads fixtures from disk inside the stepped API route.
  outputFileTracingIncludes: {
    "/api/runs/[runId]/step/**": ["./fixtures/**"],
  },
};

export default nextConfig;
