import { after, NextResponse } from "next/server";
import { completeSubscription } from "@/lib/phase-1/subscribe";
import { vaultCredential } from "@/lib/phase-1/reconcile";
import { errorText, step } from "@/lib/log";

// Called after Stripe.js finishes the 3DS challenge
export async function POST(req: Request) {
  const { workspaceId } = await req.json();
  try {
    const result = await completeSubscription(workspaceId);
    if (result.status === "active") {
      // Vault after the response; the reconciler retries if this fails
      after(() =>
        vaultCredential(result.credentialId).catch((err) => step("phase-1", "vault.background failed", "fail", { note: errorText(err), workspaceId })),
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ status: "error", message: errorText(err) }, { status: 400 });
  }
}
