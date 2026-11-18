import { notFound } from "next/navigation";
import { getEncryptionKey } from "@/lib/bt";
import { env } from "@/lib/env";
import { formatAmount, planAmount, PLANS } from "@/lib/plans";
import { getWorkspace } from "@/lib/store";
import { settings } from "@/lib/settings";
import { StatusFeed } from "@/app/components/StatusFeed";
import { Phase1Checkout } from "./Phase1Checkout";

export const dynamic = "force-dynamic";

export default async function Phase1CheckoutPage({ searchParams }: { searchParams: Promise<{ ws?: string }> }) {
  const { ws: wsId } = await searchParams;
  const ws = wsId ? getEncryptionKeyAndWorkspace(wsId) : undefined;
  if (!ws) notFound();
  const plan = PLANS.find((p) => p.id === ws.workspace.plan)!;
  const cardWrite = settings.phase1CardWrite();
  const amount = planAmount(ws.workspace.plan, ws.workspace.currency);

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_1fr]">
      <div className="space-y-6">
        <span className="pill bg-indigo-100 text-indigo-800">
          Phase 1 · {cardWrite === "proxy" ? "Elements → vault → Proxy → Stripe" : "Elements → Stripe + encrypted vault copy"}
        </span>
        <div className="card space-y-1">
          <div className="text-sm text-zinc-500">{ws.workspace.name}</div>
          <div className="text-xl font-bold">
            {plan.name} · {formatAmount(amount, ws.workspace.currency)}/mo
          </div>
        </div>
        {ws.key || cardWrite === "proxy" ? (
          <Phase1Checkout
            workspaceId={ws.workspace.id}
            planLabel={`${plan.name} · ${formatAmount(amount, ws.workspace.currency)}/mo`}
            email={ws.workspace.email}
            country={ws.workspace.country}
            amount={amount}
            currency={ws.workspace.currency}
            btPublicKey={env.btPublicKey}
            stripePublishableKey={env.stripePublishableKey}
            encryptionKey={{ keyId: ws.key?.keyId ?? "", publicKeyPem: ws.key?.publicKeyPem ?? "" }}
            cardWrite={cardWrite}
            btDown={settings.simulateBtDown()}
          />
        ) : (
          <p className="card text-sm text-red-700">
            No client encryption key cached yet. The server creates it at startup; check the boot logs.
          </p>
        )}
      </div>
      <StatusFeed workspaceId={ws.workspace.id} />
    </div>
  );
}

// Both reads are local (SQLite). No Basis Theory API call while rendering checkout.
function getEncryptionKeyAndWorkspace(id: string) {
  const workspace = getWorkspace(id);
  if (!workspace) return undefined;
  return { workspace, key: getEncryptionKey() };
}
