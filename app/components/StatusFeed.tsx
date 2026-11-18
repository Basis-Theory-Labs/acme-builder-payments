"use client";

import { useEffect, useState } from "react";

interface Feed {
  credential?: { brand: string; last4: string; vault: string; networkToken: string; ntError: string | null; nti: boolean };
  events: { id: number; ts: string; scope: string; step: string; status: string; ref: string | null; note: string | null; ms: number | null }[];
}

const ICON: Record<string, string> = { ok: "✔", fail: "✖", wait: "⏸", info: "•", skip: "↷" };
const COLOR: Record<string, string> = {
  ok: "text-emerald-600",
  fail: "text-red-600",
  wait: "text-amber-600",
  info: "text-sky-600",
  skip: "text-zinc-400",
};

// Polls the workspace feed so the page shows each backend step as it happens
export function StatusFeed({ workspaceId }: { workspaceId: string }) {
  const [feed, setFeed] = useState<Feed | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const res = await fetch(`/api/workspaces?id=${workspaceId}`, { cache: "no-store" });
      if (alive && res.ok) setFeed(await res.json());
    };
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [workspaceId]);

  const c = feed?.credential;
  return (
    <div className="card space-y-4">
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge label="Method" value={c ? (c.last4 ? `${c.brand} •••• ${c.last4}` : c.brand) : "—"} />
        <Badge label="Vault" value={c ? (c.vault === "none" ? "not vaulted (Stripe method)" : c.vault) : "—"} good={c?.vault === "active"} />
        <Badge label="Network token" value={c?.networkToken ?? "—"} good={c?.networkToken === "active"} />
        <Badge label="CIT NTI" value={c?.nti ? "stored" : "—"} good={c?.nti} />
      </div>
      <ol className="max-h-80 space-y-1 overflow-auto font-mono text-xs">
        {[...(feed?.events ?? [])].reverse().map((e) => (
          <li key={e.id} className="flex gap-2">
            <span className="text-zinc-400">{e.ts.slice(11, 19)}</span>
            <span className={COLOR[e.status]}>{ICON[e.status]}</span>
            <span className="font-semibold">{e.step}</span>
            {e.note && <span className="text-zinc-600">{e.note}</span>}
            {e.ref && <span className="text-fuchsia-600">{e.ref}</span>}
            {e.ms !== null && <span className="text-zinc-400">{e.ms}ms</span>}
          </li>
        ))}
        {!feed?.events.length && <li className="text-zinc-400">Waiting for events…</li>}
      </ol>
    </div>
  );
}

function Badge({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <span className={`pill ${good ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-700"}`}>
      {label}: {value}
    </span>
  );
}
