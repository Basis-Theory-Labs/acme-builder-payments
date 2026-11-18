import { db } from "./db";

// Runtime switches. /ops writes overrides to the settings table; env is the default.
const DEFAULTS = {
  SIMULATE_BT_DOWN: () => process.env.SIMULATE_BT_DOWN ?? "false",
  SIMULATE_STRIPE_DOWN: () => process.env.SIMULATE_STRIPE_DOWN ?? "false",
  PHASE1_ROLLOUT_PERCENT: () => process.env.PHASE1_ROLLOUT_PERCENT ?? "0",
  PHASE1_COUNTRIES: () => process.env.PHASE1_COUNTRIES ?? "BR",
  PHASE1_RENEWALS: () => process.env.PHASE1_RENEWALS ?? "orchestrated",
  PHASE1_CARD_WRITE: () => process.env.PHASE1_CARD_WRITE ?? "dual-write",
};

export type SettingKey = keyof typeof DEFAULTS;
export const SETTING_KEYS = Object.keys(DEFAULTS) as SettingKey[];

export function getSetting(key: SettingKey): string {
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? DEFAULTS[key]();
}

export function setSetting(key: SettingKey, value: string) {
  db()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

export function flag(key: SettingKey): boolean {
  return getSetting(key) === "true";
}

export const settings = {
  simulateBtDown: () => flag("SIMULATE_BT_DOWN"),
  simulateStripeDown: () => flag("SIMULATE_STRIPE_DOWN"),
  phase1Percent: () => Number(getSetting("PHASE1_ROLLOUT_PERCENT")) || 0,
  phase1Countries: () =>
    getSetting("PHASE1_COUNTRIES")
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean),
  phase1Renewals: () => getSetting("PHASE1_RENEWALS") as "orchestrated" | "stripe-native",
  phase1CardWrite: () => getSetting("PHASE1_CARD_WRITE") as "dual-write" | "proxy",
};
