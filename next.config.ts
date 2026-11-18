import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  turbopack: { root: import.meta.dirname },
  agentRules: false,
};

export default config;
