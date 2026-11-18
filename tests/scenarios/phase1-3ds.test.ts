import { describe, expect, it } from "vitest";
import { startSubscription } from "@/lib/phase-1/subscribe";
import { createCredential } from "@/lib/store";
import { createTestPm, hasEnv, newWorkspace } from "../fixtures";

// Assumes the card was already dual-written; only the CIT is under test.
describe.skipIf(!hasEnv("stripeSecretKey"))("Phase 1: CIT with Stripe 3DS", () => {
  it("returns requires_action for a card that always challenges", async () => {
    const ws = newWorkspace("phase-1");
    const pm = await createTestPm("tok_threeDSecure2Required");
    createCredential({ workspace_id: ws.id, source: "phase-1", stripe_pm_id: pm.id, bt_token_status: "none" });

    const result = await startSubscription(ws.id);

    expect(result.status).toBe("requires_action");
    if (result.status === "requires_action") expect(result.clientSecret).toMatch(/^pi_.*_secret_/);
  });

  it("returns declined when the issuer declines on save", async () => {
    const ws = newWorkspace("phase-1");
    const pm = await createTestPm("tok_chargeDeclined");
    createCredential({ workspace_id: ws.id, source: "phase-1", stripe_pm_id: pm.id, bt_token_status: "none" });

    const result = await startSubscription(ws.id);

    expect(result.status).toBe("declined");
  });

  it("returns declined when the issuer declines the first charge", async () => {
    const ws = newWorkspace("phase-1");
    const pm = await createTestPm("tok_chargeCustomerFail");
    createCredential({ workspace_id: ws.id, source: "phase-1", stripe_pm_id: pm.id, bt_token_status: "none" });

    const result = await startSubscription(ws.id);

    expect(result.status).toBe("declined");
  });
});
