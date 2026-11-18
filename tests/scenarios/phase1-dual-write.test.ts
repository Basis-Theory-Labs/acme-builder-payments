import { describe, expect, it } from "vitest";
import { ingestCard } from "@/lib/phase-1/cards";
import { reconcilePending, releaseHeldCard, vaultCredential } from "@/lib/phase-1/reconcile";
import { setSetting } from "@/lib/settings";
import { resetHealthCache } from "@/lib/bt";
import { getCredential } from "@/lib/store";
import { createRawCardPm, hasEnv, makeJwe, newWorkspace } from "../fixtures";

const card = { number: "4242424242424242", expiration_month: 12, expiration_year: new Date().getFullYear() + 3, cvc: "123" };

describe.skipIf(!hasEnv("stripeSecretKey", "btPrivateKey"))("Phase 1: Elements dual write", () => {
  it("BT healthy: pm_ at Stripe at checkout, JWE tokenized after the subscription is active", async () => {
    setSetting("SIMULATE_BT_DOWN", "false");
    resetHealthCache();
    const ws = newWorkspace("phase-1");
    const pm = await createRawCardPm(card.number);

    const cred = await ingestCard({ mode: "dual-write", workspaceId: ws.id, stripePmId: pm.id, jwe: await makeJwe(card) });
    expect(cred.bt_token_status).toBe("pending");
    expect(cred.stripe_pm_id).toBe(pm.id);

    // What the subscribe route does after the response
    releaseHeldCard(cred.id);
    await vaultCredential(cred.id);
    const vaulted = getCredential(cred.id)!;
    expect(vaulted.bt_token_status).toBe("active");
    expect(vaulted.bt_token_id).toBeTruthy();
    // 4242 isn't an NT sandbox card: provisioning is attempted and fails with a reason
    expect(["active", "failed"]).toContain(vaulted.nt_status);
  });

  it("BT down: pm_ at Stripe, JWE queued, reconciler tokenizes when BT is back", async () => {
    const ws = newWorkspace("phase-1");
    const pm = await createRawCardPm(card.number);
    const jwe = await makeJwe(card);

    setSetting("SIMULATE_BT_DOWN", "true");
    resetHealthCache();
    const cred = await ingestCard({ mode: "dual-write", workspaceId: ws.id, stripePmId: pm.id, jwe });
    expect(cred.bt_token_status).toBe("pending");
    releaseHeldCard(cred.id);
    await vaultCredential(cred.id);
    expect(getCredential(cred.id)?.bt_token_status).toBe("pending");

    setSetting("SIMULATE_BT_DOWN", "false");
    resetHealthCache();
    const result = await reconcilePending();
    expect(result.tokenized).toBeGreaterThanOrEqual(1);
    expect(getCredential(cred.id)?.bt_token_status).toBe("active");
  });
});
