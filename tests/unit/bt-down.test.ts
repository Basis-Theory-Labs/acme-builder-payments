import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = { paymentMethods: { retrieve: vi.fn() } };
vi.mock("@/lib/stripe", async (orig) => ({ ...(await orig<typeof import("@/lib/stripe")>()), stripe: () => fake }));

const { ingestCard } = await import("@/lib/phase-1/cards");
const { reconcilePending, releaseHeldCard, vaultCredential } = await import("@/lib/phase-1/reconcile");
const { createWorkspace, getCredential } = await import("@/lib/store");
const { setSetting } = await import("@/lib/settings");
const { resetHealthCache } = await import("@/lib/bt");
const { db } = await import("@/lib/db");

function btFetch(handlers: Record<string, () => Response>) {
  return vi.fn(async (input: string | URL, _init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(handlers).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    return handlers[key]();
  });
}

beforeEach(() => {
  process.env.BT_PRIVATE_API_KEY = "key_test";
  fake.paymentMethods.retrieve.mockResolvedValue({ id: "pm_9", card: { brand: "visa", last4: "4242" } });
  resetHealthCache();
});

const newWs = () => createWorkspace({ name: "t", email: "t@example.com", country: "US", currency: "usd", plan: "pro", phase: "phase-1" });
const blobStatus = (credentialId: string) =>
  (db().prepare("SELECT status FROM pending_encrypted_cards WHERE credential_id = ?").get(credentialId) as { status: string } | undefined)?.status;
const btUp = (extra: Record<string, () => Response> = {}) =>
  btFetch({
    "/status": () => Response.json({ us: { tokens: true } }),
    "/tokens": () => Response.json({ id: "tok_new", type: "card" }, { status: 201 }),
    "/network-tokens": () => Response.json({ title: "CARD_NOT_ELIGIBLE" }, { status: 422 }),
    ...extra,
  });

describe("Phase 1 dual write: vaulting happens after checkout", () => {
  it("checkout makes no Basis Theory call; the blob waits until the subscription is active", async () => {
    setSetting("SIMULATE_BT_DOWN", "false");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const cred = await ingestCard({ mode: "dual-write", workspaceId: newWs().id, stripePmId: "pm_9", jwe: "eyJ.jwe" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cred.bt_token_status).toBe("pending");
    expect(blobStatus(cred.id)).toBe("held");
    // Not released yet: the reconciler leaves it alone
    expect(await reconcilePending()).toEqual({ tokenized: 0, remaining: 0 });
    vi.unstubAllGlobals();
  });

  it("after the subscription is active: JWE → BT token → network token attempt", async () => {
    setSetting("SIMULATE_BT_DOWN", "false");
    const cred = await ingestCard({ mode: "dual-write", workspaceId: newWs().id, stripePmId: "pm_9", jwe: "eyJ.jwe" });
    const fetchMock = btUp();
    vi.stubGlobal("fetch", fetchMock);

    releaseHeldCard(cred.id);
    await vaultCredential(cred.id);

    const tokenCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/tokens"))!;
    expect(JSON.parse(String((tokenCall[1] as RequestInit).body))).toMatchObject({ type: "card", encrypted: "eyJ.jwe" });
    expect(getCredential(cred.id)).toMatchObject({ bt_token_id: "tok_new", bt_token_status: "active", nt_status: "failed", nt_error: "CARD_NOT_ELIGIBLE" });
    expect(blobStatus(cred.id)).toBe("tokenized");
    vi.unstubAllGlobals();
  });

  it("BT down: the blob stays queued and the reconciler vaults it when BT is back", async () => {
    const cred = await ingestCard({ mode: "dual-write", workspaceId: newWs().id, stripePmId: "pm_9", jwe: "eyJ.jwe" });
    releaseHeldCard(cred.id);

    setSetting("SIMULATE_BT_DOWN", "true");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await vaultCredential(cred.id);
    expect(await reconcilePending()).toEqual({ tokenized: 0, remaining: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();

    setSetting("SIMULATE_BT_DOWN", "false");
    resetHealthCache();
    vi.stubGlobal("fetch", btUp());
    expect(await reconcilePending()).toEqual({ tokenized: 1, remaining: 0 });
    expect(getCredential(cred.id)).toMatchObject({ bt_token_id: "tok_new", bt_token_status: "active" });
    vi.unstubAllGlobals();
  });

  it("the background run and the reconciler vault a blob only once", async () => {
    setSetting("SIMULATE_BT_DOWN", "false");
    const cred = await ingestCard({ mode: "dual-write", workspaceId: newWs().id, stripePmId: "pm_9", jwe: "eyJ.jwe" });
    releaseHeldCard(cred.id);
    const fetchMock = btUp();
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([vaultCredential(cred.id), reconcilePending()]);

    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/tokens"))).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("a blob from a checkout that never completed is dropped after an hour, never vaulted", async () => {
    const cred = await ingestCard({ mode: "dual-write", workspaceId: newWs().id, stripePmId: "pm_9", jwe: "eyJ.jwe" });
    db().prepare("UPDATE pending_encrypted_cards SET created_at = datetime('now', '-2 hours') WHERE credential_id = ?").run(cred.id);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await reconcilePending();

    expect(blobStatus(cred.id)).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
