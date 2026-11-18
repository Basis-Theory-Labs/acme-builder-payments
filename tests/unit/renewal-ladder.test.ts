import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = {
  invoices: { retrieve: vi.fn(), pay: vi.fn(), attachPayment: vi.fn() },
  paymentIntents: { create: vi.fn() },
};
const cko = vi.fn();

vi.mock("@/lib/stripe", async (orig) => ({ ...(await orig<typeof import("@/lib/stripe")>()), stripe: () => fake }));
vi.mock("@/lib/checkoutcom", () => ({ chargeRecurringViaProxy: (...a: unknown[]) => cko(...a) }));

const { renewInvoice, DUNNING_RETRY_DAYS } = await import("@/lib/phase-1/renewals");
const { retryDueRenewals } = await import("@/lib/phase-1/dunning");
const { declineKind } = await import("@/lib/stripe");
const { createWorkspace, createCredential, getCredential } = await import("@/lib/store");
const { setSetting } = await import("@/lib/settings");

function setup(cred: Record<string, unknown>) {
  const ws = createWorkspace({ name: "t", email: "t@example.com", country: "BR", currency: "brl", plan: "pro", phase: "phase-1" });
  const c = createCredential({ workspace_id: ws.id, source: "phase-1", stripe_pm_id: "pm_1", bt_token_id: "tok_1", bt_token_status: "active", nti_pan: "nti_pan_1", ...cred });
  fake.invoices.retrieve.mockResolvedValue({
    id: `in_${ws.id}`,
    status: "open",
    amount_due: 24900,
    currency: "brl",
    customer: "cus_1",
    collection_method: "send_invoice",
    parent: { subscription_details: { metadata: { renewals: "orchestrated", workspace_id: ws.id } } },
  });
  return { ws, c };
}

const ntCred = { nt_status: "active", nt_id: "nt_1", nt_number: "4895370012003478", nt_exp_month: 12, nt_exp_year: 2030, nti_nt: "nti_nt_1" };
// Codes Stripe test mode returns for these cards (insufficient funds; lost card, observed at attach)
const softDecline = () =>
  new Stripe.errors.StripeCardError({ message: "Your card has insufficient funds.", type: "card_error", code: "card_declined", decline_code: "insufficient_funds", advice_code: "try_again_later" });
const hardDecline = () =>
  new Stripe.errors.StripeCardError({ message: "Your card has been declined.", type: "card_error", code: "card_declined", decline_code: "lost_card", advice_code: "do_not_try_again" });
const apiError = () => new Stripe.errors.StripeAPIError({ message: "Internal error", type: "api_error" });

beforeEach(() => {
  vi.clearAllMocks();
  fake.invoices.pay.mockResolvedValue({});
  fake.invoices.attachPayment.mockResolvedValue({});
  setSetting("SIMULATE_STRIPE_DOWN", "false");
});

describe("renewal credential ladder", () => {
  it("NT present → Stripe charged with NT + NTI, payment attached to the invoice", async () => {
    setup(ntCred);
    fake.paymentIntents.create.mockResolvedValue({ id: "pi_1", latest_charge: { payment_method_details: { card: { network_transaction_id: "nti_next" } } } });

    const r = await renewInvoice("in_x");

    const params = fake.paymentIntents.create.mock.calls[0][0];
    expect(params.payment_method_data.card.network_token.number).toBe("4895370012003478");
    expect(params.payment_method_options.card.mit_exemption.network_transaction_id).toBe("nti_nt_1");
    expect(params.customer).toBe("cus_1");
    expect(fake.invoices.attachPayment).toHaveBeenCalledWith(expect.any(String), { payment_intent: "pi_1" });
    expect(fake.invoices.pay).not.toHaveBeenCalled();
    expect(r).toMatchObject({ psp: "stripe", credential: "network_token", status: "paid" });
    expect(cko).not.toHaveBeenCalled();
  });

  it("no NT → Stripe charges its own pm_", async () => {
    setup({ nt_status: "failed", nt_error: "CARD_NOT_ELIGIBLE" });
    fake.paymentIntents.create.mockResolvedValue({ id: "pi_2", latest_charge: null });

    const r = await renewInvoice("in_x");

    expect(fake.paymentIntents.create.mock.calls[0][0]).toMatchObject({ payment_method: "pm_1", off_session: true, confirm: true });
    expect(fake.invoices.attachPayment).toHaveBeenCalledWith(expect.any(String), { payment_intent: "pi_2" });
    expect(r).toMatchObject({ psp: "stripe", credential: "stripe_pm", status: "paid" });
  });

  it("Stripe processor error → Checkout.com via BT Proxy with token + PAN NTI", async () => {
    setup(ntCred);
    fake.paymentIntents.create.mockRejectedValue(apiError());
    cko.mockResolvedValue({ status: 201, payment: { id: "pay_1", approved: true, status: "Authorized", scheme_id: "sch_1" } });

    const r = await renewInvoice("in_x");

    expect(cko).toHaveBeenCalledWith(expect.objectContaining({ tokenId: "tok_1", previousNti: "nti_pan_1", amount: 24900, currency: "brl" }));
    expect(fake.invoices.pay).toHaveBeenCalledWith(expect.any(String), { paid_out_of_band: true });
    expect(fake.invoices.attachPayment).not.toHaveBeenCalled();
    expect(r).toMatchObject({ psp: "checkout.com", credential: "bt_token", status: "paid", psp_ref: "pay_1" });
  });

  it("simulated Stripe outage → failover without calling Stripe", async () => {
    setup({ nt_status: "failed" });
    setSetting("SIMULATE_STRIPE_DOWN", "true");
    cko.mockResolvedValue({ status: 201, payment: { id: "pay_2", approved: true, status: "Authorized" } });

    const r = await renewInvoice("in_x");

    expect(fake.paymentIntents.create).not.toHaveBeenCalled();
    expect(r).toMatchObject({ psp: "checkout.com", status: "paid" });
  });

  it("Stripe rejects the NT request (feature not enabled) → logged reason, card on file at Stripe, no failover", async () => {
    setup(ntCred);
    const rejected = new Stripe.errors.StripeInvalidRequestError({
      message: "Missing required param: payment_method_data[card][number].",
      type: "invalid_request_error",
      param: "payment_method_data[card][number]",
    });
    fake.paymentIntents.create.mockRejectedValueOnce(rejected).mockResolvedValueOnce({ id: "pi_pm", latest_charge: null });

    const r = await renewInvoice("in_x");

    expect(fake.paymentIntents.create.mock.calls[1][0]).toMatchObject({ payment_method: "pm_1", off_session: true });
    expect(cko).not.toHaveBeenCalled();
    expect(r).toMatchObject({ psp: "stripe", credential: "stripe_pm", status: "paid" });
    const { ntRejectionReason } = await import("@/lib/phase-1/renewals");
    expect(ntRejectionReason(rejected)).toMatch(/enable network token charges/);
  });

  it("soft decline → retry scheduled, no failover, invoice left open", async () => {
    setup(ntCred);
    fake.paymentIntents.create.mockRejectedValue(softDecline());

    const r = await renewInvoice("in_x");

    expect(cko).not.toHaveBeenCalled();
    expect(fake.invoices.pay).not.toHaveBeenCalled();
    expect(fake.invoices.attachPayment).not.toHaveBeenCalled();
    expect(r).toMatchObject({ psp: "stripe", status: "retry_scheduled", attempt: 1 });
    const inDays = (Date.parse(r!.next_attempt_at!) - Date.now()) / 86_400_000;
    expect(inDays).toBeCloseTo(DUNNING_RETRY_DAYS[0], 1);
  });

  it("hard decline → stops, no retry, no failover", async () => {
    setup(ntCred);
    fake.paymentIntents.create.mockRejectedValue(hardDecline());

    const r = await renewInvoice("in_x");

    expect(cko).not.toHaveBeenCalled();
    expect(r).toMatchObject({ psp: "stripe", status: "declined", next_attempt_at: null });
  });

  it("soft declines retry from the top of the ladder until the schedule runs out", async () => {
    setup(ntCred);
    fake.paymentIntents.create.mockRejectedValue(softDecline());

    const results = [];
    for (let i = 0; i <= DUNNING_RETRY_DAYS.length; i++) results.push(await renewInvoice("in_x"));

    expect(results.map((r) => r!.status)).toEqual([...DUNNING_RETRY_DAYS.map(() => "retry_scheduled"), "declined"]);
    expect(results.map((r) => r!.attempt)).toEqual([1, 2, 3, 4, 5]);
    // Every attempt started with the network token again
    for (const call of fake.paymentIntents.create.mock.calls) expect(call[0].payment_method_data.card.network_token).toBeDefined();
    expect(cko).not.toHaveBeenCalled();
  });

  it("dunning runner retries only what is due, and a paid retry settles the invoice", async () => {
    const { db } = await import("@/lib/db");
    db().exec("DELETE FROM renewals");
    setup({ nt_status: "failed" });
    fake.paymentIntents.create.mockRejectedValueOnce(softDecline()).mockResolvedValueOnce({ id: "pi_retry", latest_charge: null });
    await renewInvoice("in_x");

    expect(await retryDueRenewals(new Date())).toBe(0);
    expect(await retryDueRenewals(new Date(Date.now() + 2 * 86_400_000))).toBe(1);
    expect(fake.invoices.attachPayment).toHaveBeenCalledWith(expect.any(String), { payment_intent: "pi_retry" });
    expect(await retryDueRenewals(new Date(Date.now() + 30 * 86_400_000))).toBe(0);
  });

  it("classifies declines by advice_code, falling back to decline_code", () => {
    expect(declineKind("try_again_later", "insufficient_funds")).toBe("soft");
    expect(declineKind("do_not_try_again", "lost_card")).toBe("hard");
    expect(declineKind("confirm_card_data", "expired_card")).toBe("hard");
    expect(declineKind(undefined, "stolen_card")).toBe("hard");
    expect(declineKind(undefined, "generic_decline")).toBe("soft");
  });

  it("failover impossible while the card is still a queued JWE", async () => {
    setup({ bt_token_id: null, bt_token_status: "pending", nt_status: "none" });
    fake.paymentIntents.create.mockRejectedValue(apiError());

    const r = await renewInvoice("in_x");

    expect(cko).not.toHaveBeenCalled();
    expect(r).toMatchObject({ psp: "checkout.com", status: "failed", error: "no vaulted card" });
  });

  it("first NT charge starts its own chain with a cryptogram, then stores the NT NTI", async () => {
    const { c } = setup({ ...ntCred, nti_nt: null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ cryptogram: "AAA=", eci: "05" }), { status: 200 })));
    process.env.BT_PRIVATE_API_KEY = "key_test";
    fake.paymentIntents.create.mockResolvedValue({ id: "pi_3", latest_charge: { payment_method_details: { card: { network_transaction_id: "nti_nt_new" } } } });

    await renewInvoice("in_x");

    const params = fake.paymentIntents.create.mock.calls[0][0];
    expect(params.payment_method_options.card.network_token).toEqual({ cryptogram: "AAA=", electronic_commerce_indicator: "05" });
    expect(params.payment_method_options.card.mit_exemption).toBeUndefined();
    expect(getCredential(c.id)?.nti_nt).toBe("nti_nt_new");
    vi.unstubAllGlobals();
  });

  it("ignores invoices Billing collects itself", async () => {
    setup(ntCred);
    fake.invoices.retrieve.mockResolvedValue({ id: "in_y", collection_method: "charge_automatically", parent: { subscription_details: { metadata: {} } } });
    expect(await renewInvoice("in_y")).toBeNull();
    expect(fake.paymentIntents.create).not.toHaveBeenCalled();
  });
});
