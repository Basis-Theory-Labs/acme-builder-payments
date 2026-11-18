import { NextResponse } from "next/server";
import { reconcilePending } from "@/lib/phase-1/reconcile";

export async function POST() {
  return NextResponse.json(await reconcilePending());
}
