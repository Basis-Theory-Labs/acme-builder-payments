import type Stripe from "stripe";
import { errorText, step } from "../log";
import { stripe } from "../stripe";
import { getWorkspace, isCheckoutSessionClaimed } from "../store";
import { fulfillCheckoutSession } from "./forward";

// Fresh sessions are left to the success page; older ones mean the customer never got there
const GRACE_SECONDS = 120;
const LOOKBACK_SECONDS = 24 * 3600;

// Backstop without webhooks: read recent paid-checkout events from the Events API.
// Delayed methods complete unpaid and report payment later in async_payment_succeeded.
export async function sweepCompletedCheckouts(): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  let fulfilled = 0;
  const events = stripe().events.list({
    types: ["checkout.session.completed", "checkout.session.async_payment_succeeded"],
    created: { gte: now - LOOKBACK_SECONDS, lte: now - GRACE_SECONDS },
    limit: 100,
  });
  for await (const event of events) {
    const session = event.data.object as Stripe.Checkout.Session;
    const ws = session.client_reference_id ? getWorkspace(session.client_reference_id) : undefined;
    if (session.mode !== "subscription" || session.payment_status === "unpaid" || !ws || isCheckoutSessionClaimed(session.id)) continue;
    try {
      await fulfillCheckoutSession(session.id, "events-sweep");
      fulfilled++;
    } catch (err) {
      step("quick-start", "sweep.failed", "fail", { ref: session.id, note: errorText(err), workspaceId: ws.id });
    }
  }
  if (fulfilled) step("quick-start", "events-sweep", "ok", { note: `${fulfilled} missed checkout(s) fulfilled` });
  return fulfilled;
}
