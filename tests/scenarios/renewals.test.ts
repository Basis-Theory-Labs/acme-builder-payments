import { describe, expect, it } from "vitest";
import { makeNextRenewalSoftDecline } from "@/lib/ops";
import { renewInvoice } from "@/lib/phase-1/renewals";
import { vaultCredential } from "@/lib/phase-1/reconcile";
import { startSubscription } from "@/lib/phase-1/subscribe";
import { createCardToken } from "@/lib/bt";
import { setSetting } from "@/lib/settings";
import { stripe } from "@/lib/stripe";
import { createCredential, getWorkspace, latestCredential, listEvents } from "@/lib/store";
import { advanceToRenewal, createRawCardPm, createTestPm, hasEnv, newWorkspace } from "../fixtures";

// Works on both sides: Stripe test mode charges it and the BT network token sandbox provisions it
const NT_AND_STRIPE_CARD = "4000000000000093";

// Subscribed Phase 1 workspace on a test clock, renewals orchestrated by the merchant.
// Assumes the card is already vaulted: the BT token is created directly from the same test PAN.
// Without BT keys a placeholder token id stands in; the Stripe-only paths never call BT.
async function subscribedWorkspace(pan = "4242424242424242") {
  // Same card on both sides: tok_visa (4242) needs no raw card access; other PANs use raw card data APIs
  setSetting("PHASE1_RENEWALS", "orchestrated");
  const ws = newWorkspace("phase-1", "BR");
  const pm = pan === "4242424242424242" ? await createTestPm("tok_visa") : await createRawCardPm(pan);
  const year = new Date().getFullYear() + 3;
  const btToken = hasEnv("btPrivateKey") ? await createCardToken({ number: pan, expiration_month: 12, expiration_year: year }) : null;
  createCredential({
    workspace_id: ws.id,
    source: "phase-1",
    stripe_pm_id: pm.id,
    bt_token_id: btToken?.id ?? "tok_placeholder_no_bt_keys",
    bt_token_status: "active",
    ...(btToken ? {} : { nt_status: "failed" as const, nt_error: "no BT keys in test" }),
  });
  const result = await startSubscription(ws.id);
  expect(result.status).toBe("active");
  // What the subscribe route runs after the response: the network token
  if (result.status === "active") await vaultCredential(result.credentialId);
  return getWorkspace(ws.id)!;
}

describe.skipIf(!hasEnv("stripeSecretKey"))("Renewals (merchant-orchestrated, test clock)", () => {
  it("no NT → Stripe charges the pm_ off-session → payment attached to the invoice (not out of band)", async () => {
    setSetting("SIMULATE_STRIPE_DOWN", "false");
    const ws = await subscribedWorkspace();
    const inv = await advanceToRenewal(ws);

    const r = await renewInvoice(inv.id!);

    expect(r).toMatchObject({ psp: "stripe", credential: "stripe_pm", status: "paid" });
    const paid = await stripe().invoices.retrieve(inv.id!, { expand: ["payments"] });
    expect(paid.status).toBe("paid");
    const payments = paid.payments!.data.map((p) => p.payment);
    expect(payments).toContainEqual(expect.objectContaining({ type: "payment_intent", payment_intent: r!.psp_ref }));
    expect(payments.some((p) => p.type === "payment_record")).toBe(false);
  });

  // Stripe test mode has no card that attaches and then hard-declines (lost/stolen/expired fail at attach); the unit test covers hard declines
  it("soft decline (try_again_later) → retry scheduled, no failover, invoice stays open", async () => {
    setSetting("SIMULATE_STRIPE_DOWN", "false");
    const ws = await subscribedWorkspace();
    // Same as the /ops button: a card that attaches fine but declines on charge
    await makeNextRenewalSoftDecline(ws.id);
    const inv = await advanceToRenewal(ws);

    const r = await renewInvoice(inv.id!);

    expect(r).toMatchObject({ psp: "stripe", status: "retry_scheduled", attempt: 1 });
    expect(listEvents({ workspaceId: ws.id }).find((e) => e.step === "stripe.mit soft decline")?.note).toMatch(/try_again_later/);
    expect((await stripe().invoices.retrieve(inv.id!)).status).toBe("open");
  });

  // One card on both sides (4000 0000 0000 0093). Everything is real. Without network token charges on the Stripe account, Stripe rejects the NT request:
  // the reason is logged and the renewal falls back to the card on file at Stripe.
  it.skipIf(!hasEnv("btPrivateKey"))("NT provisioned → real cryptogram → NT charge at Stripe (or logged rejection + card on file)", async () => {
    setSetting("SIMULATE_STRIPE_DOWN", "false");
    const ws = await subscribedWorkspace(NT_AND_STRIPE_CARD);
    const cred = latestCredential(ws.id)!;
    expect(cred.nt_status).toBe("active");
    expect(cred.nt_number).toMatch(/^\d{13,19}$/);

    const inv = await advanceToRenewal(ws);
    const r = await renewInvoice(inv.id!);

    expect(r?.status).toBe("paid");
    expect((await stripe().invoices.retrieve(inv.id!)).status).toBe("paid");
    const rejection = listEvents({ workspaceId: ws.id }).find((e) => e.step === "stripe.nt rejected");
    if (rejection) {
      expect(rejection.note).toMatch(/enable network token charges/);
      expect(r).toMatchObject({ psp: "stripe", credential: "stripe_pm" });
    } else {
      expect(r).toMatchObject({ psp: "stripe", credential: "network_token" });
    }
  });

  it.skipIf(!hasEnv("btPrivateKey", "ckoSecretKey", "ckoProcessingChannelId"))(
    "Stripe down → Checkout.com through the BT Proxy → invoice paid out of band",
    async () => {
      const ws = await subscribedWorkspace("4242424242424242");
      const inv = await advanceToRenewal(ws);
      setSetting("SIMULATE_STRIPE_DOWN", "true");

      const r = await renewInvoice(inv.id!);
      setSetting("SIMULATE_STRIPE_DOWN", "false");

      expect(r).toMatchObject({ psp: "checkout.com", credential: "bt_token", status: "paid" });
      expect(r?.psp_ref).toMatch(/^pay_/);
      // Out of band shows as a payment record on the invoice
      const paid = await stripe().invoices.retrieve(inv.id!, { expand: ["payments"] });
      expect(paid.status).toBe("paid");
      expect(paid.payments!.data.some((p) => p.payment.type === "payment_record")).toBe(true);
    },
  );
});
