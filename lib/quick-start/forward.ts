import Stripe from "stripe";
import { required } from "../env";
import { BtError, type BtToken } from "../bt";
import { step, timed } from "../log";
import { provisionAndStoreNt } from "../network-tokens";
import { stripe } from "../stripe";
import {
  claimCheckoutSession,
  createCredential,
  getWorkspace,
  isCheckoutSessionClaimed,
  releaseCheckoutSession,
  updateWorkspace,
  type Credential,
  type Workspace,
} from "../store";

export const BT_STRIPE_FORWARD_URL = "https://api.basistheory.com/connections/stripe-forward/tokenize";

// Body Stripe sends to BT. Empty strings are replaced by Stripe with the real card values.
export function forwardBody(metadata: Record<string, string>) {
  return {
    card: { number: "", exp_month: "", exp_year: "", cvc: "", name: "" },
    metadata: { metadata },
  };
}

// Stripe Vault and Forward → BT. Requires Forwarding to be enabled on the Stripe account.
async function forwardViaStripe(pmId: string, metadata: Record<string, string>): Promise<BtToken> {
  const res = await stripe().forwarding.requests.create({
    payment_method: pmId,
    url: BT_STRIPE_FORWARD_URL,
    request: {
      headers: [{ name: "BT-API-KEY", value: required("btForwardKey") }],
      body: JSON.stringify(forwardBody(metadata)),
    },
    replacements: ["card_number", "card_expiry", "card_cvc", "cardholder_name"],
  });
  const details = res.response_details;
  if (!details || details.status >= 300) {
    throw new BtError(details?.status ?? 0, "stripe-forward failed", details?.body);
  }
  return JSON.parse(details.body) as BtToken;
}

// Stripe answers forwarding_api_inactive until Vault and Forward is enabled on the account
export function forwardRejectionReason(err: { code?: string; message: string }): string {
  if (err.code === "forwarding_api_inactive") {
    return "Stripe account can't forward cards: enable Vault and Forward (see README Setup). Subscription is unaffected";
  }
  return `Stripe rejected the forward: ${err.message}`;
}

export function isLinkPaymentMethod(pm: Stripe.PaymentMethod): boolean {
  return pm.type === "link" || (pm.card?.wallet?.type as string | undefined) === "link";
}

// Vault one Stripe PaymentMethod in BT, then provision + store the NT.
export async function vaultPaymentMethod(opts: {
  workspace: Workspace;
  paymentMethodId: string;
  nti: string | null;
}): Promise<Credential | null> {
  const { workspace: ws } = opts;
  const pm = await stripe().paymentMethods.retrieve(opts.paymentMethodId);

  if (isLinkPaymentMethod(pm)) {
    step("quick-start", "forward.skipped", "skip", {
      ref: pm.id,
      note: "Link credential, excluded from Stripe forwarding",
      workspaceId: ws.id,
    });
    return null;
  }

  const metadata = {
    stripe_pm: pm.id,
    stripe_customer: ws.stripe_customer_id ?? "",
    workspace_id: ws.id,
    source: "quick-start",
    ...(opts.nti ? { nti: opts.nti } : {}),
  };
  let token: BtToken;
  try {
    token = await timed("quick-start", "stripe.forward → bt.token", () => forwardViaStripe(pm.id, metadata), {
      ref: (t) => t.id,
      workspaceId: ws.id,
    });
  } catch (err) {
    if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) throw err;
    step("quick-start", "stripe.forward rejected", "fail", { note: forwardRejectionReason(err), workspaceId: ws.id });
    return null;
  }

  const cred = createCredential({
    workspace_id: ws.id,
    source: "quick-start",
    stripe_pm_id: pm.id,
    bt_token_id: token.id,
    bt_token_status: "active",
    brand: pm.card?.brand ?? null,
    last4: pm.card?.last4 ?? null,
    nti_pan: opts.nti,
  });
  step("quick-start", "credential.stored", "ok", { ref: cred.id, note: `${pm.card?.brand} •••• ${pm.card?.last4}`, workspaceId: ws.id });

  return provisionAndStoreNt(cred, "quick-start", pm.billing_details?.name ?? undefined);
}

export type FulfillmentTrigger = "success-page" | "events-sweep";

// Paid Checkout Session → find the subscription's card and its CIT NTI → vault it. Runs once per session.
export async function fulfillCheckoutSession(sessionId: string, trigger: FulfillmentTrigger): Promise<Credential | null> {
  if (isCheckoutSessionClaimed(sessionId)) return null;
  const session = await stripe().checkout.sessions.retrieve(sessionId, { expand: ["subscription"] });
  const ws = session.client_reference_id ? getWorkspace(session.client_reference_id) : undefined;
  if (!ws) return null;
  if (session.status !== "complete" || session.payment_status === "unpaid") {
    step("quick-start", "checkout.not-paid", "skip", { ref: session.id, note: `status=${session.status} payment_status=${session.payment_status}`, workspaceId: ws.id });
    return null;
  }
  if (!claimCheckoutSession(session.id, ws.id, trigger)) return null;

  try {
    step("quick-start", "checkout.completed", "ok", { ref: session.id, note: `via ${trigger}`, workspaceId: ws.id });

    const sub = session.subscription as Stripe.Subscription;
    updateWorkspace(ws.id, { stripe_subscription_id: sub.id });
    const pmId = typeof sub.default_payment_method === "string" ? sub.default_payment_method : sub.default_payment_method?.id;
    if (!pmId) {
      step("quick-start", "forward.skipped", "skip", { note: "subscription has no card payment method", workspaceId: ws.id });
      return null;
    }

    const nti = await citNtiForCustomer(sub.customer as string);
    step("quick-start", "stripe.cit.nti", nti ? "ok" : "info", { note: nti ? "captured" : "not returned", ref: nti, workspaceId: ws.id });

    return await vaultPaymentMethod({ workspace: { ...ws, stripe_subscription_id: sub.id }, paymentMethodId: pmId, nti });
  } catch (err) {
    // Let the next trigger (sweep) retry
    releaseCheckoutSession(session.id);
    throw err;
  }
}

// The first invoice's charge carries the NTI of the customer-initiated transaction
export async function citNtiForCustomer(customerId: string): Promise<string | null> {
  const charges = await stripe().charges.list({ customer: customerId, limit: 1 });
  return charges.data[0]?.payment_method_details?.card?.network_transaction_id ?? null;
}
