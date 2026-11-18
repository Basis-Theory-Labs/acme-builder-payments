import type Stripe from "stripe";
import { newId } from "../db";
import { step, timed } from "../log";
import { stripe } from "../stripe";
import { createStripePmViaProxy } from "../stripe-proxy";
import { createCredential, getWorkspace, type Credential, type Workspace } from "../store";
import { holdEncryptedCard } from "./reconcile";

export type CardIntake =
  // Elements wrote the card to Stripe (pm_) and encrypted a copy (JWE)
  | { mode: "dual-write"; workspaceId: string; stripePmId: string; jwe: string }
  // Elements tokenized the card in BT; the backend creates the Stripe pm_ through the BT Proxy
  | { mode: "proxy"; workspaceId: string; btTokenId: string; cardholderName?: string }
  // Non-card method or wallet collected by Stripe Elements; stays at Stripe
  | { mode: "stripe"; workspaceId: string; stripePmId: string };

export async function ingestCard(input: CardIntake): Promise<Credential> {
  const ws = getWorkspace(input.workspaceId);
  if (!ws) throw new Error(`Unknown workspace ${input.workspaceId}`);
  if (input.mode === "proxy") return ingestViaProxy(ws, input.btTokenId, input.cardholderName);

  const pm = await stripe().paymentMethods.retrieve(input.stripePmId);
  step("phase-1", "stripe.pm.received", "ok", { ref: pm.id, note: describePm(pm), workspaceId: ws.id });

  if (input.mode === "stripe") {
    const cred = createCredential({ workspace_id: ws.id, source: "phase-1", stripe_pm_id: pm.id, ...pmDetails(pm) });
    step("phase-1", "vault.skipped", "skip", { note: "Stripe-collected method, stays at Stripe", workspaceId: ws.id });
    return cred;
  }

  // No Basis Theory call while the customer waits: the JWE is vaulted after the subscription is active
  const cred = createCredential({ workspace_id: ws.id, source: "phase-1", stripe_pm_id: pm.id, bt_token_status: "pending", ...pmDetails(pm) });
  const pendingId = newId("pend");
  holdEncryptedCard(pendingId, cred.id, input.jwe);
  step("phase-1", "jwe.held", "ok", { ref: pendingId, note: "vaulted after checkout", workspaceId: ws.id });
  return cred;
}

async function ingestViaProxy(ws: Workspace, btTokenId: string, cardholderName?: string): Promise<Credential> {
  step("phase-1", "bt.token.created (elements)", "ok", { ref: btTokenId, workspaceId: ws.id });
  const pm = await timed(
    "phase-1",
    "stripe.pm.created via BT proxy",
    () => createStripePmViaProxy(btTokenId, { name: cardholderName, email: ws.email, country: ws.country }),
    { ref: (p) => p.id, note: (p) => describePm(p), workspaceId: ws.id },
  );
  return createCredential({
    workspace_id: ws.id,
    source: "phase-1",
    stripe_pm_id: pm.id,
    bt_token_id: btTokenId,
    bt_token_status: "active",
    ...pmDetails(pm),
  });
}

function pmDetails(pm: Stripe.PaymentMethod) {
  return { brand: pm.card?.brand ?? pm.type, last4: pm.card?.last4 ?? null };
}

function describePm(pm: Stripe.PaymentMethod) {
  if (!pm.card) return pm.type;
  const wallet = pm.card.wallet?.type ? ` (${pm.card.wallet.type})` : "";
  return `${pm.card.brand} •••• ${pm.card.last4}${wallet}`;
}
