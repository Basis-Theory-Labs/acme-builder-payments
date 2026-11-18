import Stripe from "stripe";
import { createCryptogram } from "../bt";
import { chargeRecurringViaProxy } from "../checkoutcom";
import { step, timed, errorText } from "../log";
import { assertStripeUp, classifyStripeError, SimulatedStripeOutage, stripe, type ChargeFailure } from "../stripe";
import {
  getWorkspace,
  getWorkspaceByCustomer,
  latestCredential,
  recordRenewal,
  scheduledRetries,
  updateCredential,
  type Credential,
  type RenewalRow,
} from "../store";

interface ChargeOk {
  psp: "stripe" | "checkout.com";
  ref: string;
  nti: string | null;
  credential: "network_token" | "stripe_pm" | "bt_token";
}

// Soft declines are retried this many days after the first decline (card networks cap reattempts; Stripe suggests at most 8)
export const DUNNING_RETRY_DAYS = [1, 3, 5, 7];

const isOrchestrated = (inv: Stripe.Invoice) =>
  inv.parent?.subscription_details?.metadata?.renewals === "orchestrated" && inv.collection_method === "send_invoice";

// invoice.finalized (or a due retry) → charge it ourselves → settle the invoice in Billing
export async function renewInvoice(invoiceId: string): Promise<RenewalRow | null> {
  const inv = await stripe().invoices.retrieve(invoiceId);
  if (!isOrchestrated(inv)) {
    step("renewal", "invoice.ignored", "skip", { ref: inv.id, note: "Billing collects this one" });
    return null;
  }
  if (inv.status !== "open" || inv.amount_due === 0) {
    step("renewal", "invoice.ignored", "skip", { ref: inv.id, note: `status=${inv.status} amount=${inv.amount_due}` });
    return null;
  }

  const wsId = inv.parent?.subscription_details?.metadata?.workspace_id;
  const ws = (wsId && getWorkspace(wsId)) || getWorkspaceByCustomer(inv.customer as string);
  const cred = ws && latestCredential(ws.id);
  if (!ws || !cred) throw new Error(`No credential for invoice ${inv.id}`);

  const retries = scheduledRetries(inv.id);
  step("renewal", retries.length ? "dunning.retry" : "invoice.finalized", "info", {
    ref: inv.id,
    note: `${(inv.amount_due / 100).toFixed(2)} ${inv.currency.toUpperCase()}${retries.length ? ` · retry ${retries.length} of ${DUNNING_RETRY_DAYS.length}` : ""}`,
    workspaceId: ws.id,
  });

  // 1. Primary: Stripe, direct (NT + NTI, or the Stripe pm_ when there is no NT)
  let failure: ChargeFailure;
  try {
    assertStripeUp();
    const ok = cred.nt_status === "active" ? await chargeNetworkTokenAtStripe(cred, inv) : await chargePmAtStripe(cred, inv);
    return settle(inv, ws.id, ok);
  } catch (err) {
    failure = err instanceof SimulatedStripeOutage ? { kind: "processor_error", message: err.message } : classifyStripeError(err);
  }

  // 2. Issuer said no: never another PSP. Soft → retry the whole ladder later; hard → stop.
  if (failure.kind === "issuer_decline") {
    const codes = [failure.code, failure.advice].filter(Boolean).join(" · ");
    const declined = {
      invoice_id: inv.id,
      workspace_id: ws.id,
      psp: "stripe",
      credential: cred.nt_status === "active" ? "network_token" : "stripe_pm",
      psp_ref: null,
      nti: null,
      error: failure.message,
      attempt: retries.length + 1,
    };
    if (failure.decline === "soft" && retries.length < DUNNING_RETRY_DAYS.length) {
      const firstDecline = retries[0] ? Date.parse(`${retries[0].created_at.replace(" ", "T")}Z`) : Date.now();
      const next = new Date(firstDecline + DUNNING_RETRY_DAYS[retries.length] * 86_400_000).toISOString();
      step("renewal", "stripe.mit soft decline", "fail", {
        note: `${codes} → retry ${retries.length + 1} of ${DUNNING_RETRY_DAYS.length} on ${next.slice(0, 10)}`,
        workspaceId: ws.id,
      });
      return recordRenewal({ ...declined, status: "retry_scheduled", next_attempt_at: next });
    }
    const why = failure.decline === "soft" ? "retries exhausted" : "hard decline";
    step("renewal", `stripe.mit ${why}`, "fail", { note: `${codes} → ask the customer for a new card`, workspaceId: ws.id });
    return recordRenewal({ ...declined, status: "declined" });
  }

  // 3. Stripe outage / processor error → Checkout.com through the BT Proxy
  step("renewal", "stripe.mit failed", "fail", { note: `${failure.message} → failover checkout.com`, workspaceId: ws.id });
  if (cred.bt_token_status !== "active" || !cred.bt_token_id) {
    step("renewal", "failover.unavailable", "fail", { note: "card not vaulted yet", workspaceId: ws.id });
    return recordRenewal({ invoice_id: inv.id, workspace_id: ws.id, psp: "checkout.com", credential: "bt_token", status: "failed", psp_ref: null, nti: null, error: "no vaulted card" });
  }

  try {
    const { status, payment } = await timed(
      "renewal",
      "cko.payment via BT proxy",
      () =>
        chargeRecurringViaProxy({
          tokenId: cred.bt_token_id!,
          amount: inv.amount_due,
          currency: inv.currency,
          previousNti: cred.nti_pan,
          reference: inv.id,
        }),
      { ref: (r) => r.payment?.id, note: (r) => `${r.status} ${r.payment?.status ?? ""}`.trim(), workspaceId: ws.id },
    );
    if (status < 300 && payment?.approved) {
      return settle(inv, ws.id, { psp: "checkout.com", ref: payment.id, nti: payment.scheme_id ?? null, credential: "bt_token" });
    }
    const reason = payment?.response_summary ?? `HTTP ${status}`;
    step("renewal", "cko.payment declined", "fail", { note: reason, workspaceId: ws.id });
    return recordRenewal({ invoice_id: inv.id, workspace_id: ws.id, psp: "checkout.com", credential: "bt_token", status: "declined", psp_ref: payment?.id ?? null, nti: null, error: reason });
  } catch (err) {
    return recordRenewal({ invoice_id: inv.id, workspace_id: ws.id, psp: "checkout.com", credential: "bt_token", status: "failed", psp_ref: null, nti: null, error: errorText(err) });
  }
}

// Stripe charges are attached to the invoice; only a charge at another PSP is paid out of band
async function settle(inv: Stripe.Invoice, workspaceId: string, ok: ChargeOk): Promise<RenewalRow> {
  if (ok.psp === "stripe") {
    await timed("renewal", "stripe.invoice payment attached", () => stripe().invoices.attachPayment(inv.id, { payment_intent: ok.ref }), {
      ref: () => inv.id,
      note: () => ok.ref,
      workspaceId,
    });
  } else {
    await timed("renewal", "stripe.invoice paid_out_of_band", () => stripe().invoices.pay(inv.id, { paid_out_of_band: true }), {
      ref: () => inv.id,
      note: () => `charged at ${ok.psp}`,
      workspaceId,
    });
  }
  const attempt = scheduledRetries(inv.id).length + 1;
  return recordRenewal({ invoice_id: inv.id, workspace_id: workspaceId, psp: ok.psp, credential: ok.credential, status: "paid", psp_ref: ok.ref, nti: ok.nti, error: null, attempt });
}

// NT MIT at Stripe. The first NT charge starts its own chain with a cryptogram (BT's guidance);
// later charges reference that chain's NTI and need no BT call.
async function chargeNetworkTokenAtStripe(cred: Credential, inv: Stripe.Invoice): Promise<ChargeOk> {
  let cryptogram: { cryptogram: string; eci: string } | null = null;
  if (!cred.nti_nt) {
    try {
      cryptogram = await timed("renewal", "bt.nt.cryptogram (chain start)", () => createCryptogram(cred.nt_id!), {
        workspaceId: cred.workspace_id,
      });
    } catch {
      step("renewal", "nt.chain-start unavailable", "info", { note: "falling back to Stripe pm_", workspaceId: cred.workspace_id });
      return chargePmAtStripe(cred, inv);
    }
  }

  const params = {
    amount: inv.amount_due,
    currency: inv.currency,
    customer: inv.customer as string,
    confirm: true,
    off_session: true,
    payment_method_data: {
      type: "card",
      card: { network_token: { number: cred.nt_number, exp_month: cred.nt_exp_month, exp_year: cred.nt_exp_year } },
    },
    payment_method_options: {
      card: cryptogram
        ? { network_token: { cryptogram: cryptogram.cryptogram, electronic_commerce_indicator: cryptogram.eci } }
        : { mit_exemption: { network_transaction_id: cred.nti_nt } },
    },
    metadata: { invoice: inv.id, workspace_id: cred.workspace_id },
    expand: ["latest_charge"],
  };

  // Network token params are not in the SDK types yet
  let pi: Stripe.PaymentIntent;
  try {
    pi = await timed(
      "renewal",
      "stripe.mit (network token)",
      () => stripe().paymentIntents.create(params as unknown as Stripe.PaymentIntentCreateParams),
      { ref: (p) => p.id, note: () => (cryptogram ? "chain start" : "nti chained"), workspaceId: cred.workspace_id },
    );
  } catch (err) {
    // Request rejected (not an issuer decline or outage): stay at Stripe with the card on file
    if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) throw err;
    step("renewal", "stripe.nt rejected", "fail", { note: ntRejectionReason(err), workspaceId: cred.workspace_id });
    step("renewal", "fallback → card on file", "info", { note: "Stripe pm_", workspaceId: cred.workspace_id });
    return chargePmAtStripe(cred, inv);
  }
  const nti = (pi.latest_charge as Stripe.Charge | null)?.payment_method_details?.card?.network_transaction_id ?? null;
  if (!cred.nti_nt && nti) updateCredential(cred.id, { nti_nt: nti });
  return { psp: "stripe", ref: pi.id, nti, credential: "network_token" };
}

// Stripe ignores network_token fields on accounts without network token charges and asks for a card number instead
export function ntRejectionReason(err: { param?: string; message: string }): string {
  if (err.param === "payment_method_data[card][number]") {
    return "Stripe account can't charge network tokens: enable network token charges (see README Setup)";
  }
  return `Stripe rejected the network token request: ${err.message}`;
}

// No NT: Stripe charges the card it already holds
async function chargePmAtStripe(cred: Credential, inv: Stripe.Invoice): Promise<ChargeOk> {
  const pi = await timed(
    "renewal",
    "stripe.mit (card on file)",
    () =>
      stripe().paymentIntents.create({
        amount: inv.amount_due,
        currency: inv.currency,
        customer: inv.customer as string,
        payment_method: cred.stripe_pm_id!,
        off_session: true,
        confirm: true,
        metadata: { invoice: inv.id, workspace_id: cred.workspace_id },
        expand: ["latest_charge"],
      }),
    { ref: (p) => p.id, workspaceId: cred.workspace_id },
  );
  const nti = (pi.latest_charge as Stripe.Charge | null)?.payment_method_details?.card?.network_transaction_id ?? null;
  return { psp: "stripe", ref: pi.id, nti, credential: "stripe_pm" };
}
