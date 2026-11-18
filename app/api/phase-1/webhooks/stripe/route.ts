import { NextResponse } from "next/server";
import { verifyStripeEvent } from "@/lib/webhooks";
import { renewInvoice } from "@/lib/phase-1/renewals";
import { errorText, step } from "@/lib/log";

export async function POST(req: Request) {
  const event = await verifyStripeEvent(req);
  if (!event) return NextResponse.json({ error: "bad signature" }, { status: 400 });

  if (event.type === "invoice.finalized" && event.data.object.billing_reason === "subscription_cycle") {
    try {
      await renewInvoice(event.data.object.id!);
    } catch (err) {
      step("renewal", "webhook.failed", "fail", { note: errorText(err) });
      return NextResponse.json({ error: errorText(err) }, { status: 500 });
    }
  }
  return NextResponse.json({ received: true });
}
