import { CompactEncrypt, importJWK } from "jose";
import type Stripe from "stripe";
import { env, type EnvKey } from "@/lib/env";
import { ensureEncryptionKey } from "@/lib/bt";
import { waitForClock } from "@/lib/ops";
import { priceIdFor, stripe } from "@/lib/stripe";
import { createWorkspace, updateWorkspace, type Workspace } from "@/lib/store";

// Stripe scenario tests only run with a test-mode key
export const hasEnv = (...keys: EnvKey[]) =>
  keys.every((k) => Boolean(env[k]) && (k !== "stripeSecretKey" || /^(sk|rk)_test_/.test(env[k])));

export function newWorkspace(phase: Workspace["phase"], country = "US") {
  const currency = country === "BR" ? "brl" : "usd";
  return createWorkspace({ name: "Scenario test", email: "scenario@example.com", country, currency, plan: "pro", phase });
}

// Stand-in for "Checkout already succeeded": customer + card + paid subscription
export async function createStripeCustomerWithSubscription(ws: Workspace, paymentMethod = "pm_card_visa") {
  const customer = await stripe().customers.create({ email: ws.email, name: ws.name, metadata: { workspace_id: ws.id } });
  const pm = await stripe().paymentMethods.attach(paymentMethod, { customer: customer.id });
  const sub = await stripe().subscriptions.create({
    customer: customer.id,
    items: [{ price: await priceIdFor(ws.plan, ws.currency) }],
    default_payment_method: pm.id,
    metadata: { workspace_id: ws.id, phase: "quick-start" },
  });
  updateWorkspace(ws.id, { stripe_customer_id: customer.id, stripe_subscription_id: sub.id });
  return { customer, pm, sub };
}

// Stripe test token → PaymentMethod. No raw card data APIs needed.
export function createTestPm(token: "tok_visa" | "tok_threeDSecure2Required" | "tok_chargeDeclined" | "tok_chargeCustomerFail") {
  return stripe().paymentMethods.create({ type: "card", card: { token }, billing_details: { name: "Jane Doe" } });
}

// Server-side stand-in for Elements' bt.client.post to Stripe (raw card data APIs must be enabled)
export function createRawCardPm(number: string, name = "Jane Doe"): Promise<Stripe.PaymentMethod> {
  return stripe().paymentMethods.create({
    type: "card",
    card: { number, exp_month: 12, exp_year: new Date().getFullYear() + 3, cvc: "123" },
    billing_details: { name },
  } as Stripe.PaymentMethodCreateParams);
}

// Same JWE Elements' bt.tokens.encrypt produces: ECDH-ES (X25519) + A256GCM, kid = key id, payload = token data
export async function makeJwe(card: { number: string; expiration_month: number; expiration_year: number; cvc?: string }) {
  const key = await ensureEncryptionKey();
  const x = key.publicKeyPem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/[\n\r]/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const jwk = { kty: "OKP", crv: "X25519", x, kid: key.keyId };
  const publicKey = await importJWK(jwk, "ECDH-ES");
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify(card)))
    .setProtectedHeader({ alg: "ECDH-ES", enc: "A256GCM", kid: key.keyId })
    .encrypt(publicKey);
}

// Moves the workspace's test clock past the next billing date and returns the renewal invoice, finalized
export async function advanceToRenewal(ws: Workspace): Promise<Stripe.Invoice> {
  const clockId = ws.stripe_test_clock_id!;
  const clock = await stripe().testHelpers.testClocks.retrieve(clockId);
  await stripe().testHelpers.testClocks.advance(clockId, { frozen_time: clock.frozen_time + 32 * 24 * 3600 });
  await waitForClock(clockId);
  const invoices = await stripe().invoices.list({ subscription: ws.stripe_subscription_id!, limit: 5 });
  const inv = invoices.data.find((i) => i.billing_reason === "subscription_cycle");
  if (!inv) throw new Error("No renewal invoice after advancing the clock");
  return inv.status === "draft" ? stripe().invoices.finalizeInvoice(inv.id!) : inv;
}
