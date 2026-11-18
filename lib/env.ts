const read = (name: string, fallback = "") => process.env[name] ?? fallback;

export const env = {
  get appUrl() { return read("APP_URL", "http://localhost:3000"); },
  get dbPath() { return read("DB_PATH", "data/app.db"); },

  get btApiUrl() { return read("BT_API_URL", "https://api.basistheory.com"); },
  get btPublicKey() { return read("NEXT_PUBLIC_BT_PUBLIC_API_KEY"); },
  get btPrivateKey() { return read("BT_PRIVATE_API_KEY"); },
  get btForwardKey() { return read("BT_FORWARD_API_KEY") || read("BT_PRIVATE_API_KEY"); },

  get stripeSecretKey() { return read("STRIPE_SECRET_KEY"); },
  get stripePublishableKey() { return read("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"); },
  get stripeWebhookSecret() { return read("STRIPE_WEBHOOK_SECRET"); },

  get ckoApiUrl() { return read("CKO_API_URL", "https://api.sandbox.checkout.com"); },
  get ckoSecretKey() { return read("CKO_SECRET_KEY"); },
  get ckoProcessingChannelId() { return read("CKO_PROCESSING_CHANNEL_ID"); },
};

export type EnvKey = keyof typeof env;

export function required(name: EnvKey): string {
  const value = env[name];
  if (!value) throw new Error(`Missing config: ${name}. See .env.example`);
  return value;
}
