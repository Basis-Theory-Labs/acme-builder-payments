import Link from "next/link";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { StatusFeed } from "@/app/components/StatusFeed";
import { errorText, step } from "@/lib/log";
import { fulfillCheckoutSession } from "@/lib/quick-start/forward";
import { getWorkspace } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function QuickStartSuccess({ searchParams }: { searchParams: Promise<{ ws?: string; session_id?: string }> }) {
  const { ws: wsId, session_id: sessionId } = await searchParams;
  const ws = wsId ? getWorkspace(wsId) : undefined;
  if (!ws) notFound();

  // Stripe redirects here with {CHECKOUT_SESSION_ID}; the backend verifies the session with Stripe before vaulting
  if (sessionId) {
    after(() =>
      fulfillCheckoutSession(sessionId, "success-page").catch((err) =>
        step("quick-start", "fulfillment.failed", "fail", { ref: sessionId, note: errorText(err), workspaceId: ws.id }),
      ),
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <span className="pill bg-amber-100 text-amber-800">Quick Start</span>
      <div>
        <h1 className="text-2xl font-bold">You&apos;re on {ws.plan === "pro" ? "Pro" : "Starter"} 🎉</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Stripe sent you back with the Checkout Session id. The backend checks that session with Stripe, forwards the card
          to the vault and provisions a network token; watch it below.
        </p>
      </div>
      <StatusFeed workspaceId={ws.id} />
      <Link href="/ops" className="btn-ghost">Open ops</Link>
    </div>
  );
}
