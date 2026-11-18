import { NextResponse } from "next/server";
import { ingestCard, type CardIntake } from "@/lib/phase-1/cards";
import { errorText } from "@/lib/log";

// mode: dual-write { stripePmId, jwe } | proxy { btTokenId } | stripe { stripePmId }
export async function POST(req: Request) {
  const body = (await req.json()) as CardIntake;
  try {
    const cred = await ingestCard({ ...body, mode: body.mode ?? "dual-write" } as CardIntake);
    return NextResponse.json({ credentialId: cred.id, vault: cred.bt_token_status });
  } catch (err) {
    return NextResponse.json({ error: errorText(err) }, { status: 400 });
  }
}
