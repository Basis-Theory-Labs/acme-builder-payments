// One-time sandbox setup. Needs STRIPE_SECRET_KEY, NEXT_PUBLIC_BT_PUBLIC_API_KEY and BT_PRIVATE_API_KEY in .env.local.
// Creates Stripe products and prices (by lookup key) and checks the BT keys are set.
import fs from "node:fs";
import pc from "picocolors";

if (fs.existsSync(".env.local")) process.loadEnvFile(".env.local");

const { env } = await import("../lib/env");
const { PLANS } = await import("../lib/plans");
const { priceLookupKey, stripe } = await import("../lib/stripe");

const log = (ok: boolean, msg: string) => console.log(`${ok ? pc.green("✔") : pc.yellow("•")} ${msg}`);

// ── Basis Theory keys ──────────────────────────────────────────────────────
const missing = (["btPublicKey", "btPrivateKey"] as const).filter((k) => !env[k]);
if (missing.length) log(false, `Missing ${missing.join(", ")} in .env.local (see .env.example for permissions); BT flows won't run`);
else log(true, `BT keys present${process.env.BT_FORWARD_API_KEY ? " (separate forward key)" : " (forward uses private key)"}`);

// ── Stripe products and prices ─────────────────────────────────────────────
for (const plan of PLANS) {
  const existing = await stripe().products.search({ query: `metadata['plan']:'${plan.id}'` });
  const product = existing.data[0] ?? (await stripe().products.create({ name: plan.name, metadata: { plan: plan.id } }));
  for (const [currency, amount] of Object.entries(plan.amounts)) {
    const lookup_key = priceLookupKey(plan.id, currency);
    const found = await stripe().prices.list({ lookup_keys: [lookup_key], limit: 1 });
    if (found.data[0]) {
      log(false, `Stripe price ${lookup_key} exists`);
      continue;
    }
    await stripe().prices.create({
      product: product.id,
      currency,
      unit_amount: amount,
      recurring: { interval: "month" },
      lookup_key,
      tax_behavior: "inclusive",
    });
    log(true, `Stripe price ${lookup_key}`);
  }
}

console.log(`
${pc.bold("Next")}
  1. Add Checkout.com sandbox keys (CKO_SECRET_KEY, CKO_PROCESSING_CHANNEL_ID, CKO_API_URL) to .env.local
  2. yarn stripe:listen:quick-start   and   yarn stripe:listen:phase-1
     (put the printed whsec_ in STRIPE_WEBHOOK_SECRET)
  3. yarn dev
`);
