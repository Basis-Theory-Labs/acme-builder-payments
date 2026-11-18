import { notFound } from "next/navigation";
import { formatAmount, planAmount, PLANS } from "@/lib/plans";
import { getWorkspace } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function QuickStartCheckout({ searchParams }: { searchParams: Promise<{ ws?: string }> }) {
  const { ws: wsId } = await searchParams;
  const ws = wsId ? getWorkspace(wsId) : undefined;
  if (!ws) notFound();
  const plan = PLANS.find((p) => p.id === ws.plan)!;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <span className="pill bg-amber-100 text-amber-800">Quick Start · Stripe Checkout + Forward</span>
      <div className="card space-y-4">
        <h1 className="text-xl font-bold">Confirm your upgrade</h1>
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-zinc-500">Workspace</dt>
          <dd className="font-medium">{ws.name}</dd>
          <dt className="text-zinc-500">Plan</dt>
          <dd className="font-medium">{plan.name} · monthly</dd>
          <dt className="text-zinc-500">Price</dt>
          <dd className="font-medium">{formatAmount(planAmount(ws.plan, ws.currency), ws.currency)}</dd>
        </dl>
        <form action="/api/quick-start/checkout" method="post">
          <input type="hidden" name="workspaceId" value={ws.id} />
          <input type="hidden" name="riskToken" value="demo-risk-token" />
          <button className="btn w-full" type="submit">Continue to secure checkout</button>
        </form>
        <p className="text-xs text-zinc-500">
          Nothing changes for the customer: same hosted page, same Billing subscription. After payment, the card is
          forwarded from Stripe to the vault and a network token is provisioned.
        </p>
      </div>
    </div>
  );
}
