import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // PDF.js uses browser-only APIs; stub out canvas for SSR
  turbopack: {
    // Pin the workspace root to this directory so Next.js doesn't
    // pick up a lockfile from a parent folder.
    root: path.resolve(__dirname),
    resolveAlias: {
      canvas: "./lib/canvas-stub.ts",
    },
  },
};

export default nextConfig;
