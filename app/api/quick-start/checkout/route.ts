import { NextResponse } from "next/server";
import { createCheckoutSession } from "@/lib/quick-start/checkout";
import { getWorkspace } from "@/lib/store";

export async function POST(req: Request) {
  const form = await req.formData();
  const ws = getWorkspace(String(form.get("workspaceId")));
  if (!ws) return NextResponse.json({ error: "unknown workspace" }, { status: 404 });
  const url = await createCheckoutSession(ws, String(form.get("riskToken") ?? "") || undefined);
  return NextResponse.redirect(url, 303);
}
