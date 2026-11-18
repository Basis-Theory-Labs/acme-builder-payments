import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = {
  paymentMethods: { retrieve: vi.fn(), attach: vi.fn() },
  customers: { create: vi.fn() },
  prices: { list: vi.fn() },
  subscriptions: { create: vi.fn() },
  paymentIntents: { confirm: vi.fn() },
};
vi.mock("@/lib/stripe", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe")>()),
  stripe: () => fake,
  priceIdFor: async () => "price_1",
}));

const { ingestCard } = await import("@/lib/phase-1/cards");
const { startSubscription } = await import("@/lib/phase-1/subscribe");
const { createStripePmViaProxy } = await import("@/lib/stripe-proxy");
const { createWorkspace, getCredential } = await import("@/lib/store");
const { setSetting } = await import("@/lib/settings");

const newWs = () => createWorkspace({ name: "t", email: "t@example.com", country: "US", currency: "usd", plan: "pro", phase: "phase-1" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  process.env.BT_PRIVATE_API_KEY = "key_test";
  process.env.STRIPE_SECRET_KEY = "";
});

describe("proxy mode: BT token → Stripe pm_ through the BT Proxy", () => {
  it("sends a form body with token expressions to Stripe, never a PAN", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => Response.json({ id: "pm_px", type: "card", card: { brand: "visa", last4: "4242" } }));
    vi.stubGlobal("fetch", fetchMock);

    const pm = await createStripePmViaProxy("tok-1", { name: "Jane Doe" });

    const [url, init] = fetchMock.mock.calls[0];
    const headers = init!.headers as Record<string, string>;
    const form = new URLSearchParams(String(init!.body));
    expect(pm.id).toBe("pm_px");
    expect(url).toMatch(/\/proxy$/);
    expect(headers["BT-PROXY-URL"]).toBe("https://api.stripe.com/v1/payment_methods");
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(headers.Authorization).toBe("Bearer sk_test_x");
    expect(form.get("card[number]")).toBe('{{ token: tok-1 | json: "$.data.number" }}');
    expect(form.get("card[exp_year]")).toContain('card_exp: "YYYY"');
    expect(String(init!.body)).not.toMatch(/\d{13,19}/);
  });

  it("stores the BT token and the Stripe pm_ together, vaulted from the start", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "pm_px", type: "card", card: { brand: "visa", last4: "4242" } })));
    const ws = newWs();

    const cred = await ingestCard({ mode: "proxy", workspaceId: ws.id, btTokenId: "tok-1", cardholderName: "Jane Doe" });

    expect(getCredential(cred.id)).toMatchObject({ bt_token_id: "tok-1", bt_token_status: "active", stripe_pm_id: "pm_px", last4: "4242" });
  });

  it("surfaces Stripe errors returned through the proxy", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Your card number is incorrect." } }, { status: 402 })));
    await expect(createStripePmViaProxy("tok-1")).rejects.toThrow("Your card number is incorrect.");
  });
});

describe("Stripe-collected methods (wallets, APMs)", () => {
  it("records the pm_ without touching Basis Theory", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    fake.paymentMethods.retrieve.mockResolvedValue({ id: "pm_bank", type: "us_bank_account" });
    const ws = newWs();

    const cred = await ingestCard({ mode: "stripe", workspaceId: ws.id, stripePmId: "pm_bank" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cred).toMatchObject({ bt_token_status: "none", brand: "us_bank_account", last4: null });
  });

  it("subscribes with the Stripe method and keeps renewals on Billing", async () => {
    setSetting("PHASE1_RENEWALS", "orchestrated");
    fake.paymentMethods.retrieve.mockResolvedValue({ id: "pm_bank", type: "us_bank_account" });
    fake.paymentMethods.attach.mockResolvedValue({ id: "pm_bank", type: "us_bank_account" });
    fake.customers.create.mockResolvedValue({ id: "cus_1" });
    fake.prices.list.mockResolvedValue({ data: [{ id: "price_1" }] });
    fake.subscriptions.create.mockResolvedValue({ id: "sub_1", latest_invoice: { payments: { data: [{ payment: { payment_intent: "pi_1" } }] } } });
    fake.paymentIntents.confirm.mockResolvedValue({ id: "pi_1", status: "requires_action", client_secret: "pi_1_secret_x", next_action: { type: "verify_with_microdeposits" } });
    const ws = newWs();
    await ingestCard({ mode: "stripe", workspaceId: ws.id, stripePmId: "pm_bank" });

    const result = await startSubscription(ws.id);

    const params = fake.subscriptions.create.mock.calls[0][0];
    expect(params.default_payment_method).toBe("pm_bank");
    expect(params.payment_settings.payment_method_types).toBeUndefined();
    expect(params.metadata.renewals).toBe("stripe-native");
    expect(result).toMatchObject({ status: "requires_action", clientSecret: "pi_1_secret_x" });
  });
});
