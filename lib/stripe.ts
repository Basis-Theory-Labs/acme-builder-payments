import Stripe from "stripe";
import { required } from "./env";
import { settings } from "./settings";

let client: Stripe | null = null;

// Test mode only. This POC creates customers, subscriptions and charges.
export function stripe(): Stripe {
  const key = required("stripeSecretKey");
  if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
    throw new Error("STRIPE_SECRET_KEY must be a test-mode key (sk_test_…). Refusing to run against live Stripe.");
  }
  return (client ??= new Stripe(key));
}

export const CURRENCIES = { US: "usd", BR: "brl", DE: "eur", MX: "usd", GB: "usd" } as const;

export function priceLookupKey(plan: string, currency: string) {
  return `${plan}_monthly_${currency}`;
}

export async function priceIdFor(plan: string, currency: string): Promise<string> {
  const key = priceLookupKey(plan, currency);
  const prices = await stripe().prices.list({ lookup_keys: [key], active: true, limit: 1 });
  const price = prices.data[0];
  if (!price) throw new Error(`No Stripe price for lookup key ${key}. Run yarn setup:sandbox`);
  return price.id;
}

// Processor errors and outages can fail over. Issuer declines cannot: soft ones are retried later, hard ones stop.
export type ChargeFailure = {
  kind: "issuer_decline" | "processor_error";
  message: string;
  code?: string;
  advice?: string;
  decline?: "soft" | "hard";
};

const HARD_DECLINE_CODES = new Set(["stolen_card", "lost_card", "pickup_card", "fraudulent", "expired_card", "incorrect_number", "invalid_account"]);

// Stripe's advice_code first (try_again_later / do_not_try_again / confirm_card_data), decline_code when it's missing
export function declineKind(adviceCode?: string, declineCode?: string): "soft" | "hard" {
  if (adviceCode === "try_again_later") return "soft";
  if (adviceCode === "do_not_try_again" || adviceCode === "confirm_card_data") return "hard";
  return declineCode && HARD_DECLINE_CODES.has(declineCode) ? "hard" : "soft";
}

export function classifyStripeError(err: unknown): ChargeFailure {
  if (err instanceof Stripe.errors.StripeCardError) {
    const code = err.decline_code ?? err.code;
    return { kind: "issuer_decline", message: err.message, code, advice: err.advice_code, decline: declineKind(err.advice_code, code) };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { kind: "processor_error", message };
}

export class SimulatedStripeOutage extends Error {
  constructor() {
    super("Simulated Stripe outage (SIMULATE_STRIPE_DOWN)");
  }
}

export function assertStripeUp() {
  if (settings.simulateStripeDown()) throw new SimulatedStripeOutage();
}

// NTI of the most recent successful charge on a PaymentIntent
export async function ntiFromPaymentIntent(paymentIntentId: string): Promise<string | null> {
  const pi = await stripe().paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
  const charge = pi.latest_charge as Stripe.Charge | null;
  return charge?.payment_method_details?.card?.network_transaction_id ?? null;
}
