import { NextResponse } from "next/server";
import { getWorkspace, latestCredential, listEvents } from "@/lib/store";

// Status feed for the checkout pages (no card data)
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const ws = getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "unknown workspace" }, { status: 404 });
  const cred = latestCredential(id);
  return NextResponse.json({
    workspace: { id: ws.id, phase: ws.phase, subscription: ws.stripe_subscription_id },
    credential: cred && {
      brand: cred.brand,
      last4: cred.last4,
      vault: cred.bt_token_status,
      networkToken: cred.nt_status,
      ntError: cred.nt_error,
      nti: Boolean(cred.nti_pan),
    },
    events: listEvents({ workspaceId: id, limit: 30 }),
  });
}
