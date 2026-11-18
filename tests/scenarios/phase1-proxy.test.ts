import { describe, expect, it } from "vitest";
import { ingestCard } from "@/lib/phase-1/cards";
import { createCardToken } from "@/lib/bt";
import { stripe } from "@/lib/stripe";
import { hasEnv, newWorkspace } from "../fixtures";

// Assumes Elements already tokenized the card: the BT token is created directly from a test PAN.
// Needs Stripe raw card data APIs (the request reaches Stripe from BT with the card filled in).
describe.skipIf(!hasEnv("stripeSecretKey", "btPrivateKey"))("Phase 1: proxy card write", () => {
  it("BT token → BT Proxy → Stripe pm_, stored as vaulted", async () => {
    const ws = newWorkspace("phase-1");
    const token = await createCardToken({ number: "4242424242424242", expiration_month: 12, expiration_year: new Date().getFullYear() + 3 });

    const cred = await ingestCard({ mode: "proxy", workspaceId: ws.id, btTokenId: token.id, cardholderName: "Jane Doe" });

    expect(cred.bt_token_status).toBe("active");
    const pm = await stripe().paymentMethods.retrieve(cred.stripe_pm_id!);
    expect(pm.card?.last4).toBe("4242");
  });
});
