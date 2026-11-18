import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Acme Builder · Payments POC",
  description: "Vault-first checkout POC: Stripe Checkout + Forward, Elements dual write, PSP failover.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="border-b border-zinc-200 bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
            <Link href="/" className="flex items-center gap-2 font-bold">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand text-sm text-white">A</span>
              Acme Builder
            </Link>
            <nav className="flex gap-4 text-sm text-zinc-600">
              <Link href="/">Pricing</Link>
              <Link href="/ops">Ops</Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-10">{children}</main>
      </body>
    </html>
  );
}
