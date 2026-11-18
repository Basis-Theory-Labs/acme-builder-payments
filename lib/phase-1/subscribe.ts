import Stripe from "stripe";
import { env } from "../env";
import { step, timed } from "../log";
import { ensureCustomer } from "../quick-start/checkout";
import { settings } from "../settings";
import { ntiFromPaymentIntent, priceIdFor, stripe } from "../stripe";
import { getWorkspace, latestCredential, updateCredential, updateWorkspace, type Workspace } from "../store";
import { releaseHeldCard } from "./reconcile";

export type SubscribeResult =
  | { status: "active"; subscriptionId: string; credentialId: string }
  | { status: "requires_action"; clientSecret: string }
  | { status: "declined"; message: string };

async function ensureTestClock(ws: Workspace): Promise<string | undefined> {
  if (!env.stripeSecretKey.startsWith("sk_test_")) return undefined;
  if (ws.stripe_test_clock_id) return ws.stripe_test_clock_id;
  const clock = await stripe().testHelpers.testClocks.create({
    frozen_time: Math.floor(Date.now() / 1000),
    name: ws.id,
  });
  updateWorkspace(ws.id, { stripe_test_clock_id: clock.id });
  return clock.id;
}

function invoicePaymentIntentId(invoice: Stripe.Invoice): string | undefined {
  const payment = invoice.payments?.data[0]?.payment;
  const pi = payment?.payment_intent;
  return typeof pi === "string" ? pi : pi?.id;
}

// CIT: create the subscription with the pm_ (card or Stripe method), confirm on-session (Stripe 3DS / next actions apply)
export async function startSubscription(workspaceId: string): Promise<SubscribeResult> {
  const ws = getWorkspace(workspaceId);
  const cred = ws && latestCredential(ws.id);
  if (!ws || !cred?.stripe_pm_id) throw new Error("Workspace has no card yet");

  const testClock = await ensureTestClock(ws);
  const customer = await ensureCustomer({ ...ws, phase: "phase-1" }, { testClock });
  let pm: Stripe.PaymentMethod;
  try {
    pm = await timed("phase-1", "stripe.pm.attached", () => stripe().paymentMethods.attach(cred.stripe_pm_id!, { customer }), {
      ref: (p) => p.id,
      workspaceId: ws.id,
    });
  } catch (err) {
    // Some issuers decline when the card is saved, before the first charge
    if (err instanceof Stripe.errors.StripeCardError) return { status: "declined", message: err.message };
    throw err;
  }

  // Merchant-orchestrated renewals only for vaulted cards; Stripe-only methods stay on Billing
  const renewals = cred.bt_token_status === "none" ? "stripe-native" : settings.phase1Renewals();

  const sub = await timed(
    "phase-1",
    "stripe.subscription.created",
    async () =>
      stripe().subscriptions.create({
        customer,
        items: [{ price: await priceIdFor(ws.plan, ws.currency) }],
        default_payment_method: cred.stripe_pm_id!,
        payment_behavior: "default_incomplete",
        // Payment method types come from the Stripe Dashboard (explicit lists are rejected on current API versions)
        payment_settings: { save_default_payment_method: "on_subscription" },
        metadata: { workspace_id: ws.id, phase: "phase-1", renewals },
        expand: ["latest_invoice.payments"],
      }),
    { ref: (s) => s.id, workspaceId: ws.id },
  );
  updateWorkspace(ws.id, { stripe_subscription_id: sub.id });

  const piId = invoicePaymentIntentId(sub.latest_invoice as Stripe.Invoice);
  if (!piId) throw new Error("First invoice has no PaymentIntent");

  try {
    const pi = await timed(
      "phase-1",
      "stripe.cit.confirmed",
      () =>
        stripe().paymentIntents.confirm(piId, {
          payment_method: cred.stripe_pm_id!,
          return_url: `${env.appUrl}/phase-1/checkout?ws=${ws.id}`,
        }),
      { ref: (p) => p.id, note: (p) => p.status, workspaceId: ws.id },
    );
    if (pi.status === "requires_action") {
      step("phase-1", "stripe.next_action", "wait", { note: `${pi.next_action?.type ?? "3ds"} → Stripe.js`, workspaceId: ws.id });
      return { status: "requires_action", clientSecret: pi.client_secret! };
    }
  } catch (err) {
    if (err instanceof Stripe.errors.StripeCardError) {
      step("phase-1", "stripe.cit.declined", "fail", { note: err.decline_code ?? err.code ?? err.message, workspaceId: ws.id });
      return { status: "declined", message: err.message };
    }
    throw err;
  }

  return completeSubscription(ws.id);
}

// After the CIT succeeds (directly or after 3DS): keep the NTI, move renewals to the merchant, release the card for vaulting
export async function completeSubscription(workspaceId: string): Promise<SubscribeResult> {
  const ws = getWorkspace(workspaceId);
  const cred = ws && latestCredential(ws.id);
  if (!ws?.stripe_subscription_id || !cred) throw new Error("No subscription to complete");

  let sub = await stripe().subscriptions.retrieve(ws.stripe_subscription_id, { expand: ["latest_invoice.payments"] });
  const piId = invoicePaymentIntentId(sub.latest_invoice as Stripe.Invoice);
  const pi = piId ? await stripe().paymentIntents.retrieve(piId) : null;
  if (pi?.status !== "succeeded") {
    return { status: "declined", message: `Payment ${pi?.status ?? "missing"}` };
  }

  const nti = await ntiFromPaymentIntent(pi.id);
  updateCredential(cred.id, { nti_pan: nti });
  step("phase-1", "stripe.cit.nti", nti ? "ok" : "info", { note: nti ? "captured" : "not returned", ref: nti, workspaceId: ws.id });

  if (sub.metadata.renewals === "orchestrated" && sub.collection_method !== "send_invoice") {
    sub = await timed(
      "phase-1",
      "stripe.renewals → merchant",
      () => stripe().subscriptions.update(sub.id, { collection_method: "send_invoice", days_until_due: 7 }),
      { note: () => "collection_method=send_invoice", workspaceId: ws.id },
    );
  }

  step("phase-1", "subscription.active", "ok", { ref: sub.id, workspaceId: ws.id });

  // BT token (dual write) and network token are created after the response: see vaultCredential()
  releaseHeldCard(cred.id);
  if (cred.bt_token_status !== "none") {
    step("phase-1", "vault.background", "info", { note: "BT token and network token created after checkout returns", workspaceId: ws.id });
  }
  return { status: "active", subscriptionId: sub.id, credentialId: cred.id };
}
