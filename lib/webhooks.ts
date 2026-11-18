import type Stripe from "stripe";
import { env } from "./env";
import { step } from "./log";
import { stripe } from "./stripe";

export async function verifyStripeEvent(req: Request): Promise<Stripe.Event | null> {
  const payload = await req.text();
  const signature = req.headers.get("stripe-signature") ?? "";
  try {
    return stripe().webhooks.constructEvent(payload, signature, env.stripeWebhookSecret);
  } catch {
    step("ops", "webhook.signature invalid", "fail");
    return null;
  }
}
