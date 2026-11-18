import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { errorText, step } from "@/lib/log";
import { advanceOneMonth, makeNextRenewalSoftDecline, processLatestInvoice, waitForClock } from "@/lib/ops";
import { reconcilePending } from "@/lib/phase-1/reconcile";
import { sweepCompletedCheckouts } from "@/lib/quick-start/sweep";
import { getSetting, setSetting, SETTING_KEYS, type SettingKey } from "@/lib/settings";
import { listCredentials, listEvents, listRenewals, listWorkspaces } from "@/lib/store";
import { resetHealthCache } from "@/lib/bt";
import { AutoRefresh } from "./AutoRefresh";

export const dynamic = "force-dynamic";

async function saveSettings(formData: FormData) {
  "use server";
  for (const key of SETTING_KEYS) {
    const value = formData.get(key);
    if (value !== null) setSetting(key, String(value));
  }
  resetHealthCache();
  step("ops", "settings.saved", "info", {
    note: SETTING_KEYS.map((k) => `${k}=${getSetting(k)}`).join(" "),
  });
  revalidatePath("/ops");
}

async function runAction(formData: FormData) {
  "use server";
  const action = String(formData.get("action"));
  const ws = String(formData.get("workspaceId") ?? "");
  try {
    if (action === "reconcile") await reconcilePending();
    if (action === "sweep") await sweepCompletedCheckouts();
    if (action === "advance") {
      const clockId = await advanceOneMonth(ws);
      // Billing catches up in the background; the step log shows "ready" when it does
      after(() => waitForClock(clockId, ws).catch((err) => step("ops", "stripe.test-clock failed", "fail", { note: errorText(err), workspaceId: ws })));
    }
    if (action === "renew") await processLatestInvoice(ws);
    if (action === "soft-decline") await makeNextRenewalSoftDecline(ws);
  } catch (err) {
    step("ops", `${action}.failed`, "fail", { note: errorText(err), workspaceId: ws || undefined });
  }
  revalidatePath("/ops");
}

// CSS-only tooltip: shows on hover/focus straight away (the native title tooltip is slow and easy to miss)
function Hint({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <span tabIndex={0} className="group relative inline-block underline decoration-dotted underline-offset-2 outline-none">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full right-0 z-10 mb-1 hidden whitespace-nowrap rounded bg-zinc-900 px-2 py-1 font-mono text-[11px] font-normal text-white shadow group-hover:block group-focus:block"
      >
        {text}
      </span>
    </span>
  );
}

const SWITCHES: { key: SettingKey; label: string; options: string[] }[] = [
  { key: "SIMULATE_BT_DOWN", label: "Simulate Basis Theory down", options: ["false", "true"] },
  { key: "SIMULATE_STRIPE_DOWN", label: "Simulate Stripe down (renewals)", options: ["false", "true"] },
  { key: "PHASE1_CARD_WRITE", label: "Phase 1 card write", options: ["dual-write", "proxy"] },
  { key: "PHASE1_RENEWALS", label: "Phase 1 renewals", options: ["orchestrated", "stripe-native"] },
];

export default function OpsPage() {
  const workspaces = listWorkspaces();
  const credentials = listCredentials();
  const renewals = listRenewals();
  const events = listEvents({ limit: 80 });
  // Remount the form after a save so it shows the stored values (React resets forms after an action)
  const settingsKey = SETTING_KEYS.map((k) => getSetting(k)).join("|");

  return (
    <div className="space-y-8">
      <AutoRefresh seconds={4} />
      <h1 className="text-2xl font-bold">Ops</h1>

      <section className="grid gap-6 lg:grid-cols-2">
        <form key={settingsKey} action={saveSettings} className="card space-y-3">
          <h2 className="font-semibold">Switches</h2>
          {SWITCHES.map((s) => (
            <div key={s.key} className="flex items-center justify-between gap-4 text-sm">
              <label htmlFor={s.key}>{s.label}</label>
              <select id={s.key} name={s.key} defaultValue={getSetting(s.key)} className="field w-40">
                {s.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </div>
          ))}
          <div className="flex items-center justify-between gap-4 text-sm">
            <label htmlFor="PHASE1_ROLLOUT_PERCENT">Phase 1 rollout %</label>
            <input id="PHASE1_ROLLOUT_PERCENT" name="PHASE1_ROLLOUT_PERCENT" type="number" min={0} max={100} defaultValue={getSetting("PHASE1_ROLLOUT_PERCENT")} className="field w-40" />
          </div>
          <div className="flex items-center justify-between gap-4 text-sm">
            <label htmlFor="PHASE1_COUNTRIES">Phase 1 countries</label>
            <input id="PHASE1_COUNTRIES" name="PHASE1_COUNTRIES" defaultValue={getSetting("PHASE1_COUNTRIES")} className="field w-40" />
          </div>
          <button className="btn" type="submit">Save</button>
        </form>

        <div className="card space-y-3">
          <h2 className="font-semibold">Actions</h2>
          <form action={runAction}>
            <input type="hidden" name="action" value="reconcile" />
            <button className="btn-ghost">Run reconciler (queued JWEs → tokens)</button>
          </form>
          <form action={runAction}>
            <input type="hidden" name="action" value="sweep" />
            <button className="btn-ghost">Sweep missed checkouts (Quick Start)</button>
          </form>
          <p className="text-xs text-zinc-500">Renewals (subscribed Phase 1 workspaces with a test clock):</p>
          {workspaces
            .filter((w) => w.stripe_test_clock_id && w.stripe_subscription_id)
            .map((w) => (
              <div key={w.id} className="flex items-center gap-2 text-sm">
                <span className="w-40 truncate font-mono text-xs">{w.id}</span>
                <form action={runAction}>
                  <input type="hidden" name="action" value="advance" />
                  <input type="hidden" name="workspaceId" value={w.id} />
                  <button className="btn-ghost">+1 month</button>
                </form>
                <form action={runAction}>
                  <input type="hidden" name="action" value="renew" />
                  <input type="hidden" name="workspaceId" value={w.id} />
                  <button className="btn-ghost">Process renewal</button>
                </form>
                <form action={runAction}>
                  <input type="hidden" name="action" value="soft-decline" />
                  <input type="hidden" name="workspaceId" value={w.id} />
                  <button className="btn-ghost">Next renewal declines (soft)</button>
                </form>
              </div>
            ))}
        </div>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="font-semibold">Credentials</h2>
        <p className="mb-3 text-xs text-zinc-500">
          NTI (network transaction ID). PAN: from the signup charge with the card, used for failover. NT: from the network token&apos;s own chain, used for network token renewals. Hover for the value.
        </p>
        <table className="w-full text-left text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className="py-1">Workspace</th><th>Source</th><th>Card</th><th>Stripe pm</th><th>Vault</th><th>NT</th><th>NTI (PAN / NT)</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {credentials.map((c) => (
              <tr key={c.id} className="border-t border-zinc-100">
                <td className="py-1">{c.workspace_name}</td>
                <td>{c.source}</td>
                <td>{c.brand} •••• {c.last4}</td>
                <td>{c.stripe_pm_id?.slice(0, 14)}</td>
                <td>{c.bt_token_status}</td>
                <td title={c.nt_error ?? ""}>{c.nt_status}{c.nt_error ? ` (${c.nt_error})` : ""}</td>
                <td>
                  <Hint text={c.nti_pan ? `PAN NTI: ${c.nti_pan}` : "No NTI from the signup charge"}>{c.nti_pan ? "✔" : "—"}</Hint>
                  {" / "}
                  <Hint text={c.nti_nt ? `NT NTI: ${c.nti_nt}` : "Set on the first renewal charged with the network token"}>{c.nti_nt ? "✔" : "—"}</Hint>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="mb-3 font-semibold">Renewals</h2>
        <table className="w-full text-left text-xs">
          <thead className="text-zinc-500">
            <tr><th className="py-1">Invoice</th><th>PSP</th><th>Credential</th><th>Status</th><th>Attempt</th><th>Next attempt</th><th>PSP ref</th><th>Error</th></tr>
          </thead>
          <tbody className="font-mono">
            {renewals.map((r) => (
              <tr key={r.id} className="border-t border-zinc-100">
                <td className="py-1">{r.invoice_id}</td><td>{r.psp}</td><td>{r.credential}</td><td>{r.status}</td><td>{r.attempt}</td><td>{r.next_attempt_at?.slice(0, 10)}</td><td>{r.psp_ref}</td><td>{r.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2 className="mb-3 font-semibold">Step log</h2>
        <ol className="space-y-1 font-mono text-xs">
          {events.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-2">
              <span className="text-zinc-400">{e.ts.slice(11, 19)}</span>
              <span className="w-24 text-zinc-500">[{e.scope}]</span>
              <span className={{ ok: "text-emerald-600", fail: "text-red-600", wait: "text-amber-600", info: "text-sky-600", skip: "text-zinc-400" }[e.status]}>
                {{ ok: "✔", fail: "✖", wait: "⏸", info: "•", skip: "↷" }[e.status]}
              </span>
              <span className="font-semibold">{e.step}</span>
              {e.note && <span className="text-zinc-600">{e.note}</span>}
              {e.ref && <span className="text-fuchsia-600">{e.ref}</span>}
              {e.ms !== null && <span className="text-zinc-400">{e.ms}ms</span>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
