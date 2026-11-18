export const PLANS = [
  { id: "starter", name: "Starter", blurb: "For side projects", amounts: { usd: 2000, brl: 9900, eur: 1900 } },
  { id: "pro", name: "Pro", blurb: "For teams shipping daily", amounts: { usd: 5000, brl: 24900, eur: 4500 } },
] as const;

export const COUNTRIES = [
  { code: "US", name: "United States", currency: "usd" },
  { code: "BR", name: "Brazil", currency: "brl" },
  { code: "DE", name: "Germany", currency: "eur" },
  { code: "GB", name: "United Kingdom", currency: "usd" },
  { code: "MX", name: "Mexico", currency: "usd" },
] as const;

export function currencyFor(country: string): string {
  return COUNTRIES.find((c) => c.code === country)?.currency ?? "usd";
}

export function formatAmount(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);
}

export function planAmount(planId: string, currency: string): number {
  const plan = PLANS.find((p) => p.id === planId);
  return plan?.amounts[currency as keyof (typeof PLANS)[number]["amounts"]] ?? 0;
}
