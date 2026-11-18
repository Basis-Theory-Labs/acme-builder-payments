import type Stripe from "stripe";
import { proxy } from "./bt";
import { required } from "./env";

const expr = (tokenId: string, path: string, filter = "") =>
  `{{ token: ${tokenId} | json: "${path}"${filter ? ` | ${filter}` : ""} }}`;

// Creates the Stripe PaymentMethod from a vaulted card. BT fills in the card data; this service only holds the token id.
export async function createStripePmViaProxy(
  tokenId: string,
  billing: { name?: string; email?: string; country?: string } = {},
): Promise<Stripe.PaymentMethod> {
  const form = new URLSearchParams({
    type: "card",
    "card[number]": expr(tokenId, "$.data.number"),
    "card[exp_month]": expr(tokenId, "$.data", 'card_exp: "MM"'),
    "card[exp_year]": expr(tokenId, "$.data", 'card_exp: "YYYY"'),
    "card[cvc]": expr(tokenId, "$.data.cvc"),
  });
  if (billing.name) form.set("billing_details[name]", billing.name);
  if (billing.email) form.set("billing_details[email]", billing.email);
  if (billing.country) form.set("billing_details[address][country]", billing.country);

  const res = await proxy<Stripe.PaymentMethod & { error?: { message: string } }>(
    "https://api.stripe.com/v1/payment_methods",
    form,
    { Authorization: `Bearer ${required("stripeSecretKey")}` },
  );
  if (res.status >= 300 || !res.body?.id) {
    throw new Error(`Stripe via BT proxy: ${res.body?.error?.message ?? `HTTP ${res.status}`}`);
  }
  return res.body;
}
