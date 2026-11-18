import { describe, expect, it } from "vitest";
import { citNtiForCustomer, vaultPaymentMethod } from "@/lib/quick-start/forward";
import { getCredential, getWorkspace, listEvents } from "@/lib/store";
import { createStripeCustomerWithSubscription, hasEnv, newWorkspace } from "../fixtures";

// Assumes Stripe Checkout already succeeded: customer + card + paid subscription exist.
describe.skipIf(!hasEnv("stripeSecretKey", "btForwardKey", "btPrivateKey"))("Quick Start: Stripe card → BT vault", () => {
  // Real Stripe Forwarding API. Without Vault and Forward on the account, Stripe rejects it and the reason is logged.
  it("forwards the subscription card (or logs why Stripe refused), keeps the CIT NTI", async () => {
    const ws = newWorkspace("quick-start");
    const { customer, pm } = await createStripeCustomerWithSubscription(ws);

    const nti = await citNtiForCustomer(customer.id);
    const cred = await vaultPaymentMethod({ workspace: getWorkspace(ws.id)!, paymentMethodId: pm.id, nti });

    const rejection = listEvents({ workspaceId: ws.id }).find((e) => e.step === "stripe.forward rejected");
    if (rejection) {
      expect(cred).toBeNull();
      expect(rejection.note).toMatch(/enable Vault and Forward/);
      return;
    }
    const stored = getCredential(cred!.id)!;
    expect(stored.bt_token_id).toBeTruthy();
    expect(stored.bt_token_status).toBe("active");
    expect(stored.stripe_pm_id).toBe(pm.id);
    expect(stored.nti_pan).toBe(nti);
    // NT sandbox only provisions its own test PANs; a Stripe test card may legitimately fail
    expect(["active", "failed"]).toContain(stored.nt_status);
  });
});
