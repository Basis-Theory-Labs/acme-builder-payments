import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = { checkout: { sessions: { retrieve: vi.fn() } } };
vi.mock("@/lib/stripe", async (orig) => ({ ...(await orig<typeof import("@/lib/stripe")>()), stripe: () => fake }));

const { fulfillCheckoutSession } = await import("@/lib/quick-start/forward");
const { createWorkspace, isCheckoutSessionClaimed, listEvents } = await import("@/lib/store");

// Subscription without a card pm_: fulfillment stops after "checkout.completed", no forward call needed
const session = (id: string, wsId: string, fields: Record<string, unknown> = {}) => ({
  id,
  client_reference_id: wsId,
  status: "complete",
  payment_status: "paid",
  subscription: { id: "sub_1", customer: "cus_1", default_payment_method: null },
  ...fields,
});

const newWs = () => createWorkspace({ name: "t", email: "t@example.com", country: "US", currency: "usd", plan: "pro", phase: "quick-start" });

beforeEach(() => fake.checkout.sessions.retrieve.mockReset());

describe("Quick Start fulfillment (success page + Events sweep)", () => {
  it("does nothing for a session that isn't paid", async () => {
    const ws = newWs();
    fake.checkout.sessions.retrieve.mockResolvedValue(session("cs_open", ws.id, { status: "open", payment_status: "unpaid" }));
    await fulfillCheckoutSession("cs_open", "success-page");
    expect(isCheckoutSessionClaimed("cs_open")).toBe(false);
    expect(listEvents({ workspaceId: ws.id }).map((e) => e.step)).toContain("checkout.not-paid");
  });

  it("fulfills a session once, whichever trigger comes first", async () => {
    const ws = newWs();
    fake.checkout.sessions.retrieve.mockResolvedValue(session("cs_paid", ws.id));
    await Promise.all([fulfillCheckoutSession("cs_paid", "success-page"), fulfillCheckoutSession("cs_paid", "events-sweep")]);
    await fulfillCheckoutSession("cs_paid", "success-page");

    const completed = listEvents({ workspaceId: ws.id }).filter((e) => e.step === "checkout.completed");
    expect(completed).toHaveLength(1);
  });

  it("releases the session when fulfillment throws, so the sweep can retry", async () => {
    const ws = newWs();
    fake.checkout.sessions.retrieve.mockResolvedValue(session("cs_err", ws.id, { subscription: null }));
    await expect(fulfillCheckoutSession("cs_err", "success-page")).rejects.toThrow();
    expect(isCheckoutSessionClaimed("cs_err")).toBe(false);
  });

  it("ignores sessions that don't belong to a local workspace", async () => {
    fake.checkout.sessions.retrieve.mockResolvedValue(session("cs_other", "ws_elsewhere"));
    expect(await fulfillCheckoutSession("cs_other", "events-sweep")).toBeNull();
    expect(isCheckoutSessionClaimed("cs_other")).toBe(false);
  });
});
