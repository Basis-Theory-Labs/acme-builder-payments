import { redirect } from "next/navigation";
import { COUNTRIES, PLANS, currencyFor, formatAmount } from "@/lib/plans";
import { phaseFor, type Phase } from "@/lib/rollout";
import { settings } from "@/lib/settings";
import { createWorkspace } from "@/lib/store";
import { newId } from "@/lib/db";
import { step } from "@/lib/log";

export const dynamic = "force-dynamic";

async function startCheckout(formData: FormData) {
  "use server";
  const country = String(formData.get("country"));
  const forced = String(formData.get("phase") ?? "") as Phase | "";
  const id = newId("ws");

  // Rollout knob: country list first, then a stable percentage of workspaces
  const phase = forced || phaseFor({ id, country }, { percent: settings.phase1Percent(), countries: settings.phase1Countries() });
  const ws = createWorkspace({
    id,
    name: String(formData.get("name") || "My workspace"),
    email: String(formData.get("email") || "demo@example.com"),
    country,
    currency: currencyFor(country),
    plan: String(formData.get("plan")),
    phase,
  });
  step("ops", "rollout.assigned", "info", { ref: ws.id, note: `${phase}${forced ? " (forced)" : ""} · ${country}`, workspaceId: ws.id });
  redirect(`/${phase}/checkout?ws=${ws.id}`);
}

export default function PricingPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Upgrade your workspace</h1>
        <p className="mt-2 text-zinc-600">
          Pick a plan. The rollout flag decides whether you land on the Quick Start checkout (hosted) or the Phase 1
          checkout (Elements).
        </p>
      </div>

      <form action={startCheckout} className="grid gap-6 md:grid-cols-[1fr_320px]">
        <div className="grid gap-4 sm:grid-cols-2">
          {PLANS.map((plan, i) => (
            <label key={plan.id} className="card cursor-pointer has-[:checked]:border-brand has-[:checked]:ring-2 has-[:checked]:ring-brand/20">
              <input type="radio" name="plan" value={plan.id} defaultChecked={i === 1} className="sr-only" />
              <div className="text-sm font-semibold text-brand">{plan.name}</div>
              <div className="mt-2 text-3xl font-bold">
                {formatAmount(plan.amounts.usd, "usd")}
                <span className="text-base font-medium text-zinc-500">/mo</span>
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                {formatAmount(plan.amounts.brl, "brl")} · {formatAmount(plan.amounts.eur, "eur")}
              </div>
              <p className="mt-3 text-sm text-zinc-600">{plan.blurb}</p>
            </label>
          ))}
        </div>

        <div className="card space-y-4">
          <div>
            <label className="label" htmlFor="name">Workspace</label>
            <input id="name" name="name" className="field" defaultValue="Moonshot Labs" />
          </div>
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input id="email" name="email" type="email" className="field" defaultValue="founder@example.com" />
          </div>
          <div>
            <label className="label" htmlFor="country">Country</label>
            <select id="country" name="country" className="field" defaultValue="US">
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name} ({c.currency.toUpperCase()})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="phase">Checkout</label>
            <select id="phase" name="phase" className="field" defaultValue="">
              <option value="">Use rollout flag</option>
              <option value="quick-start">Force Quick Start</option>
              <option value="phase-1">Force Phase 1</option>
            </select>
          </div>
          <button className="btn w-full" type="submit">Continue</button>
        </div>
      </form>
    </div>
  );
}
