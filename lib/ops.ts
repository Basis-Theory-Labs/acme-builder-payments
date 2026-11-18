import type Stripe from "stripe";
import { step, timed } from "./log";
import { renewInvoice } from "./phase-1/renewals";
import { settings } from "./settings";
import { stripe } from "./stripe";
import { getWorkspace, latestCredential, updateCredential } from "./store";

// Demo helper: move a Phase 1 workspace's test clock forward one month so Billing issues the next invoice.
// Returns once Stripe accepts the advance; call waitForClock to know when Billing has caught up.
export async function advanceOneMonth(workspaceId: string) {
  const ws = getWorkspace(workspaceId);
  if (!ws?.stripe_test_clock_id) throw new Error("Workspace has no test clock (Phase 1 only)");
  const clock = await stripe().testHelpers.testClocks.retrieve(ws.stripe_test_clock_id);
  const target = clock.frozen_time + 32 * 24 * 3600;
  await timed("ops", "stripe.test-clock advancing", () => stripe().testHelpers.testClocks.advance(clock.id, { frozen_time: target }), {
    ref: (c) => c.id,
    note: () => new Date(target * 1000).toISOString().slice(0, 10),
    workspaceId,
  });
  return clock.id;
}

export async function waitForClock(clockId: string, workspaceId?: string) {
  for (let i = 0; i < 120; i++) {
    const c = await stripe().testHelpers.testClocks.retrieve(clockId);
    if (c.status === "ready") {
      if (workspaceId) step("ops", "stripe.test-clock ready", "ok", { ref: c.id, note: new Date(c.frozen_time * 1000).toISOString().slice(0, 10), workspaceId });
      return c;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Test clock did not become ready");
}

// Demo helper: Stripe's 4000 0000 0000 0341 saves fine, then declines every charge with try_again_later (a soft decline).
// It becomes the card on file and the network token is set aside, so the next renewal reaches it and declines.
export async function makeNextRenewalSoftDecline(workspaceId: string) {
  const ws = getWorkspace(workspaceId);
  const cred = ws && latestCredential(ws.id);
  if (!ws?.stripe_subscription_id || !cred) throw new Error("No subscription: checkout never completed for this workspace");
  const pm = await timed(
    "ops",
    "demo.soft-decline card on file",
    () => stripe().paymentMethods.attach("pm_card_chargeCustomerFail", { customer: ws.stripe_customer_id as string }),
    { ref: (p) => p.id, note: () => "4000 0000 0000 0341 · network token set aside", workspaceId },
  );
  updateCredential(cred.id, { stripe_pm_id: pm.id, nt_status: "failed", nt_error: "set aside for the soft-decline demo" });
  if (settings.simulateStripeDown()) {
    step("ops", "demo.soft-decline", "info", { note: "Simulate Stripe down is on: the renewal fails over instead of declining", workspaceId });
  }
  return pm.id;
}

// Demo helper without `stripe listen`: finalize the latest renewal invoice and run the renewal handler
export async function processLatestInvoice(workspaceId: string) {
  const ws = getWorkspace(workspaceId);
  if (!ws?.stripe_subscription_id) throw new Error("No subscription: checkout never completed for this workspace");
  if (ws.stripe_test_clock_id) await waitForClock(ws.stripe_test_clock_id);
  const invoices = await stripe().invoices.list({ subscription: ws.stripe_subscription_id, limit: 5 });
  let inv = invoices.data.find((i) => i.billing_reason === "subscription_cycle" && (i.status === "draft" || i.status === "open"));
  if (!inv) {
    step("ops", "renewal.none", "skip", { note: "no draft/open cycle invoice, advance the clock first", workspaceId });
    return null;
  }
  if (inv.status === "draft") inv = (await stripe().invoices.finalizeInvoice(inv.id!)) as Stripe.Invoice;
  return renewInvoice(inv.id!);
}
