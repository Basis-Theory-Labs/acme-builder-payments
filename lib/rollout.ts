import { createHash } from "node:crypto";

export type Phase = "quick-start" | "phase-1";

export interface RolloutConfig {
  percent: number;
  countries: string[];
}

// Stable 0-99 bucket per workspace
export function bucket(workspaceId: string): number {
  const hash = createHash("sha256").update(workspaceId).digest();
  return hash.readUInt32BE(0) % 100;
}

export function phaseFor(workspace: { id: string; country: string }, cfg: RolloutConfig): Phase {
  if (cfg.countries.includes(workspace.country.toUpperCase())) return "phase-1";
  if (bucket(workspace.id) < cfg.percent) return "phase-1";
  return "quick-start";
}
