import { db } from "./db";
import { env, required } from "./env";
import { settings } from "./settings";
import { step } from "./log";

export class BtError extends Error {
  constructor(
    public status: number,
    public title: string,
    public body: unknown,
  ) {
    const detail = (body as { detail?: string } | null)?.detail;
    super(`BT ${status} ${title}${detail && detail !== title ? `: ${detail}` : ""}`);
  }
}

export async function btRequest<T>(
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(`${env.btApiUrl}${path}`, {
    method,
    headers: { "BT-API-KEY": apiKey, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? safeJson(text) : null;
  if (!res.ok) throw new BtError(res.status, errorTitle(json) ?? res.statusText, json);
  return json as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// BT errors: { title, detail, errors } or network token errors with a title like CARD_NOT_ELIGIBLE
function errorTitle(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const j = json as Record<string, unknown>;
  const errors = j.errors as Record<string, unknown> | undefined;
  const first = errors && Object.values(errors)[0];
  return (j.title as string) ?? (Array.isArray(first) ? String(first[0]) : undefined) ?? (j.detail as string);
}

// ── Health ─────────────────────────────────────────────────────────────────

let lastHealth: { at: number; up: boolean } | null = null;

export async function isBtHealthy(): Promise<boolean> {
  if (settings.simulateBtDown()) return false;
  if (lastHealth && Date.now() - lastHealth.at < 10_000) return lastHealth.up;
  let up = false;
  try {
    const res = await fetch(`${env.btApiUrl}/status?region=us`, { signal: AbortSignal.timeout(3_000) });
    const json = (await res.json()) as { us?: { tokens?: boolean } };
    up = res.ok && json.us?.tokens === true;
  } catch {
    up = false;
  }
  lastHealth = { at: Date.now(), up };
  return up;
}

export function resetHealthCache() {
  lastHealth = null;
}

// ── Tokens ─────────────────────────────────────────────────────────────────

export interface BtToken {
  id: string;
  type: string;
  fingerprint?: string;
  data?: { number?: string; expiration_month?: number | string; expiration_year?: number | string };
  card?: { brand?: string; bin?: string; last4?: string; funding?: string };
  metadata?: Record<string, string>;
}

export function createTokenFromJwe(jwe: string, metadata: Record<string, string>) {
  return btRequest<BtToken>("POST", "/tokens", required("btPrivateKey"), { type: "card", encrypted: jwe, metadata });
}

export function createCardToken(
  data: { number: string; expiration_month: number; expiration_year: number },
  metadata: Record<string, string> = {},
) {
  return btRequest<BtToken>("POST", "/tokens", required("btPrivateKey"), { type: "card", data, metadata });
}

// ── Network tokens ─────────────────────────────────────────────────────────

export interface BtNetworkToken {
  id: string;
  status: string;
  par?: string;
  data: { number: string; expiration_month: number; expiration_year: number };
  network_token?: { brand?: string; last4?: string };
}

export function provisionNetworkToken(tokenId: string, cardholderName?: string) {
  return btRequest<BtNetworkToken>("POST", "/network-tokens", required("btPrivateKey"), {
    token_id: tokenId,
    ...(cardholderName ? { cardholder_info: { name: cardholderName } } : {}),
  });
}

// Requires network-token:reveal so data.number is the full NT
export function revealNetworkToken(id: string) {
  return btRequest<BtNetworkToken>("GET", `/network-tokens/${id}`, required("btPrivateKey"));
}

export function createCryptogram(id: string) {
  return btRequest<{ cryptogram: string; eci: string }>(
    "POST",
    `/network-tokens/${id}/cryptogram`,
    required("btPrivateKey"),
    {},
  );
}

// ── Client encryption key ──────────────────────────────────────────────────

export interface EncryptionKey {
  keyId: string;
  publicKeyPem: string;
  expiresAt: string;
}

const ROTATE_BEFORE_MS = 14 * 24 * 3600 * 1000;

// Local read only. Never calls BT, so checkout rendering does not depend on BT.
export function getEncryptionKey(): EncryptionKey | null {
  const row = db()
    .prepare("SELECT key_id, public_key_pem, expires_at FROM bt_keys ORDER BY created_at DESC LIMIT 1")
    .get() as { key_id: string; public_key_pem: string; expires_at: string } | undefined;
  if (!row) return null;
  return { keyId: row.key_id, publicKeyPem: row.public_key_pem, expiresAt: row.expires_at };
}

// Startup only: create a key when none exists or the current one is close to expiry
export async function ensureEncryptionKey(): Promise<EncryptionKey> {
  const current = getEncryptionKey();
  if (current && new Date(current.expiresAt).getTime() - Date.now() > ROTATE_BEFORE_MS) {
    step("boot", "bt.key.cached", "ok", { ref: current.keyId, note: `expires ${current.expiresAt.slice(0, 10)}` });
    return current;
  }
  const start = Date.now();
  const key = await btRequest<{ key_id: string; public_key_pem: string; expires_at: string }>(
    "POST",
    "/keys",
    required("btPrivateKey"),
    {},
  );
  db()
    .prepare("INSERT INTO bt_keys (key_id, public_key_pem, expires_at) VALUES (?, ?, ?)")
    .run(key.key_id, key.public_key_pem, key.expires_at);
  step("boot", "bt.key.created", "ok", { ref: key.key_id, ms: Date.now() - start });
  return { keyId: key.key_id, publicKeyPem: key.public_key_pem, expiresAt: key.expires_at };
}

// ── Proxy ──────────────────────────────────────────────────────────────────

// body: object → JSON, URLSearchParams → form-urlencoded (e.g. Stripe)
export async function proxy<T>(
  destination: string,
  body: Record<string, unknown> | URLSearchParams,
  headers: Record<string, string>,
): Promise<{ status: number; body: T }> {
  const form = body instanceof URLSearchParams;
  const res = await fetch(`${env.btApiUrl}/proxy`, {
    method: "POST",
    headers: {
      "BT-API-KEY": required("btPrivateKey"),
      "BT-PROXY-URL": destination,
      "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json",
      ...headers,
    },
    body: form ? body.toString() : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? safeJson(text) : null) as T };
}
