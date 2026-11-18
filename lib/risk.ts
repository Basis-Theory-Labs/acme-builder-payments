import { step } from "./log";

// Placeholder for the existing pre-checkout risk check (bot / account abuse). Unchanged by either phase.
export async function riskCheck(workspaceId: string, token?: string): Promise<{ allow: boolean }> {
  step("quick-start", "risk.check", "ok", { note: token ? "token present" : "no token (demo)", workspaceId });
  return { allow: true };
}
