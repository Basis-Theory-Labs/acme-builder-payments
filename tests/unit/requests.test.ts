import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardBody, forwardRejectionReason, isLinkPaymentMethod } from "@/lib/quick-start/forward";
import { chargeRecurringViaProxy } from "@/lib/checkoutcom";
import type Stripe from "stripe";

afterEach(() => vi.unstubAllGlobals());

describe("Stripe → BT forward body", () => {
  it("leaves card fields empty for Stripe to replace", () => {
    const body = forwardBody({ stripe_pm: "pm_1" });
    expect(body.card).toEqual({ number: "", exp_month: "", exp_year: "", cvc: "", name: "" });
    expect(body.metadata.metadata.stripe_pm).toBe("pm_1");
  });

  it("explains Stripe's forwarding_api_inactive rejection", () => {
    expect(forwardRejectionReason({ code: "forwarding_api_inactive", message: "not authorized" })).toMatch(/enable Vault and Forward/);
    expect(forwardRejectionReason({ message: "other" })).toBe("Stripe rejected the forward: other");
  });

  it("detects Link credentials (excluded from forwarding)", () => {
    expect(isLinkPaymentMethod({ type: "link" } as Stripe.PaymentMethod)).toBe(true);
    expect(isLinkPaymentMethod({ type: "card", card: { wallet: null } } as unknown as Stripe.PaymentMethod)).toBe(false);
  });
});

describe("Checkout.com MIT through the BT Proxy", () => {
  it("sends token expressions and the NTI, never a PAN", async () => {
    process.env.CKO_SECRET_KEY = "sk_sbox_test";
    process.env.CKO_PROCESSING_CHANNEL_ID = "pc_test";
    process.env.BT_PRIVATE_API_KEY = "key_test";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "pay_1", approved: true, status: "Authorized" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await chargeRecurringViaProxy({ tokenId: "tok-123", amount: 2500, currency: "brl", previousNti: "nti_1", reference: "in_1" });

    expect(res.payment.approved).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(String(init.body));
    expect(url).toMatch(/\/proxy$/);
    expect(headers["BT-PROXY-URL"]).toMatch(/checkout\.com\/payments$/);
    expect(body.source.number).toBe('{{ token: tok-123 | json: "$.data.number" }}');
    expect(body).toMatchObject({ merchant_initiated: true, payment_type: "Recurring", previous_payment_id: "nti_1", currency: "BRL" });
  });
});
