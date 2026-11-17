import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@match-cut/core"],
  webpack(config) {
    // Workspace packages are TypeScript source with NodeNext-style ".js" import paths.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
