"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { loadStripe } from "@stripe/stripe-js";
import {
  BasisTheoryProvider,
  CardNumberElement,
  CVVElement,
  ExpiryElement,
  useBasisTheory,
} from "@basis-theory/react-elements";
import type {
  CardNumberElementRef,
  CVVElementRef,
  ExpiryElementRef,
} from "@basis-theory/react-elements";
import { StripeMethodForm, WalletButtons } from "./StripeMethods";

interface Props {
  workspaceId: string;
  planLabel: string;
  email: string;
  country: string;
  amount: number;
  currency: string;
  btPublicKey: string;
  stripePublishableKey: string;
  encryptionKey: { keyId: string; publicKeyPem: string };
  cardWrite: "dual-write" | "proxy";
  btDown: boolean;
}

type Step = {
  label: string;
  state: "todo" | "doing" | "done" | "error";
  detail?: string;
};

// The border lives on FieldShell (same look as .field); the Element itself draws no border.
// Shell is 42px with a 1px border, so the input inside is 40px.
const FIELD_HEIGHT = "40px";
const BT_THEME = {
  colors: {
    primary: "#5b5bd6",
    error: "#dc2626",
    success: "#059669",
    text: { primary: "#18181b", placeholder: "#a1a1aa" },
    background: { default: "#ffffff", focus: "#ffffff" },
    border: {
      default: "transparent",
      hover: "transparent",
      focus: "transparent",
      error: "transparent",
    },
  },
  typography: {
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize: { sm: "13px", base: "14px", lg: "16px" },
    fontWeight: { normal: "400" },
  },
  spacing: { sm: "8px", md: "12px", lg: "16px" },
  sizing: { input: { height: FIELD_HEIGHT } },
  borders: { radius: { base: "8px" }, width: { base: "0px" } },
};

// Stable reference: the provider rebuilds the SDK (and remounts every Element) when options change identity
const BT_OPTIONS = {
  allowHttpClient: true,
  themeMode: "light" as const,
  theme: BT_THEME,
};

export function Phase1Checkout(props: Props) {
  const stripePromise = useMemo(
    () => loadStripe(props.stripePublishableKey),
    [props.stripePublishableKey],
  );
  const [tab, setTab] = useState<"card" | "stripe">("card");
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{
    subscriptionId: string;
    vault: string;
  } | null>(null);
  const radarRef = useRef<string | null>(null);

  // Radar session: fraud signals for the pm_ created outside Stripe.js
  useEffect(() => {
    stripePromise.then(async (s) => {
      const radar = await s?.createRadarSession();
      radarRef.current = radar?.radarSession?.id ?? null;
    });
  }, [stripePromise]);

  const progress = {
    start: (labels: string[]) =>
      setSteps(
        labels.map((label, i) => ({
          label,
          state: i === 0 ? "doing" : "todo",
        })),
      ),
    mark: (i: number, state: Step["state"], detail?: string) =>
      setSteps((prev) =>
        prev.map((s, j) =>
          j === i ? { ...s, state, detail: detail ?? s.detail } : s,
        ),
      ),
    fail: (message: string) =>
      setSteps((prev) => {
        const i = prev.findIndex((s) => s.state === "doing");
        return prev.map((s, j) =>
          j === i ? { ...s, state: "error", detail: message } : s,
        );
      }),
  };

  // Shared tail for every method: vault/record the pm_ → subscribe → next action (3DS, redirect, QR)
  async function finish(cardsBody: Record<string, unknown>, firstStep: number) {
    progress.mark(firstStep, "doing");
    const card = await post("/api/phase-1/cards", {
      workspaceId: props.workspaceId,
      ...cardsBody,
    });
    progress.mark(
      firstStep,
      "done",
      {
        active: "vaulted",
        pending: "vaulted after checkout",
        none: "stays at Stripe",
      }[card.vault as string],
    );

    progress.mark(firstStep + 1, "doing");
    let sub = await post("/api/phase-1/subscribe", {
      workspaceId: props.workspaceId,
    });
    if (sub.status === "requires_action") {
      progress.mark(firstStep + 1, "doing", "customer action (Stripe.js)");
      const stripe = await stripePromise;
      const result = await stripe!.handleNextAction({
        clientSecret: sub.clientSecret,
      });
      if (result.error) throw new Error(result.error.message);
      sub = await post("/api/phase-1/subscribe/complete", {
        workspaceId: props.workspaceId,
      });
    }
    if (sub.status !== "active")
      throw new Error(sub.message ?? "Payment failed");
    progress.mark(firstStep + 1, "done", sub.subscriptionId);
    setDone({
      subscriptionId: sub.subscriptionId,
      vault: card.vault as string,
    });
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      progress.fail(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // Wallets and other Stripe methods: Stripe collects, no vault copy
  const onStripePaymentMethod = (pmId: string) =>
    run(async () => {
      progress.start([
        "Create payment method (Stripe Elements)",
        "Record it (stays at Stripe)",
        "Start subscription",
      ]);
      progress.mark(0, "done", pmId);
      await finish({ mode: "stripe", stripePmId: pmId }, 1);
    });

  // Success shows in place of the checkout; failures leave it as is (the step list and the log show why).
  // The checkout stays mounted (hidden): unmounting tears down the Elements iframes.
  return (
    <>
      {done && <CheckoutSuccess planLabel={props.planLabel} {...done} />}
      <div className="card space-y-5" hidden={!!done}>
        <WalletButtons
          stripePromise={stripePromise}
          amount={props.amount}
          currency={props.currency}
          onPaymentMethod={onStripePaymentMethod}
        />

        <div className="flex gap-1 rounded-lg bg-zinc-100 p-1 text-sm font-medium">
          <TabButton active={tab === "card"} onClick={() => setTab("card")}>
            Card · Basis Theory
          </TabButton>
          <TabButton active={tab === "stripe"} onClick={() => setTab("stripe")}>
            Other methods · Stripe
          </TabButton>
        </div>

        {/* Both panes stay mounted; the tabs only show/hide them */}
        <div hidden={tab !== "card"}>
          <BasisTheoryProvider apiKey={props.btPublicKey} options={BT_OPTIONS}>
            <CardForm
              {...props}
              busy={busy}
              radarRef={radarRef}
              run={run}
              progress={progress}
              finish={finish}
            />
          </BasisTheoryProvider>
        </div>
        <div hidden={tab !== "stripe"}>
          <StripeMethodForm
            stripePromise={stripePromise}
            amount={props.amount}
            currency={props.currency}
            busy={busy}
            onPaymentMethod={onStripePaymentMethod}
          />
        </div>

        {steps.length > 0 && (
          <ol className="space-y-1.5 border-t border-zinc-100 pt-4 text-sm">
            {steps.map((s) => (
              <li key={s.label} className="flex items-start gap-2">
                <span className="w-4">
                  {{ todo: "○", doing: "◌", done: "✔", error: "✖" }[s.state]}
                </span>
                <span
                  className={
                    s.state === "error"
                      ? "text-red-700"
                      : s.state === "done"
                        ? "text-zinc-900"
                        : "text-zinc-500"
                  }
                >
                  {s.label}
                  {s.detail && (
                    <span className="ml-2 font-mono text-xs text-zinc-400">
                      {s.detail}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  );
}

function CheckoutSuccess({
  planLabel,
  subscriptionId,
  vault,
}: {
  planLabel: string;
  subscriptionId: string;
  vault: string;
}) {
  const vaultNote =
    vault === "none"
      ? "This payment method stays at Stripe; Billing collects the renewals."
      : "The vault copy and the network token are created in the background; the log on the right shows them arrive.";
  return (
    <div className="card space-y-4">
      <div className="flex items-center gap-3">
        <span
          className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-100 text-lg text-emerald-700"
          aria-hidden
        >
          ✔
        </span>
        <div>
          <div className="text-lg font-semibold">Subscription active</div>
          <div className="text-sm text-zinc-600">{planLabel}</div>
        </div>
      </div>
      <p className="text-sm text-zinc-600">
        The first payment went through. {vaultNote}
      </p>
      <div className="font-mono text-xs text-zinc-500">{subscriptionId}</div>
      <div className="flex gap-2">
        <Link href="/ops" className="btn-ghost">
          Open ops
        </Link>
        <Link href="/" className="btn-ghost">
          Back to plans
        </Link>
      </div>
    </div>
  );
}

function CardForm(
  props: Props & {
    busy: boolean;
    radarRef: React.RefObject<string | null>;
    run: (fn: () => Promise<void>) => Promise<void>;
    progress: {
      start: (l: string[]) => void;
      mark: (i: number, s: Step["state"], d?: string) => void;
    };
    finish: (body: Record<string, unknown>, firstStep: number) => Promise<void>;
  },
) {
  const { bt } = useBasisTheory();
  const cardRef = useRef<CardNumberElementRef | null>(null);
  const expiryRef = useRef<ExpiryElementRef | null>(null);
  const cvvRef = useRef<CVVElementRef | null>(null);
  const [name, setName] = useState("Jane Doe");
  const [valid, setValid] = useState({
    card: false,
    expiry: false,
    cvv: false,
  });
  const [focus, setFocus] = useState<"card" | "expiry" | "cvv" | null>(null);
  const { progress, cardWrite } = props;
  const blocked = cardWrite === "proxy" && props.btDown;

  // dual-write: Elements → Stripe pm_ + local JWE. No Basis Theory API call.
  const dualWrite = async () => {
    progress.start([
      "Write card to Stripe (from the Elements iframe)",
      "Encrypt card locally (JWE)",
      "Send pm_ + JWE to backend",
      "Start subscription",
    ]);
    progress.mark(1, "doing");
    const [pm, jwe] = await Promise.all([
      bt!.client
        .post(
          "https://api.stripe.com/v1/payment_methods",
          {
            type: "card",
            "card[number]": cardRef.current,
            "card[exp_month]": expiryRef.current!.month(),
            "card[exp_year]": expiryRef.current!.year(),
            "card[cvc]": cvvRef.current,
            "billing_details[name]": name,
            "billing_details[email]": props.email,
            "billing_details[address][country]": props.country,
            ...(props.radarRef.current
              ? { "radar_options[session]": props.radarRef.current }
              : {}),
          },
          {
            headers: {
              Authorization: `Bearer ${props.stripePublishableKey}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
          },
        )
        .then((r) => {
          const id = (r as { id: string }).id;
          progress.mark(0, "done", id);
          return id;
        }),
      bt!.tokens
        .encrypt(
          {
            type: "card",
            data: {
              number: cardRef.current,
              expiration_month: expiryRef.current!.month(),
              expiration_year: expiryRef.current!.year(),
              cvc: cvvRef.current,
            },
          },
          props.encryptionKey.publicKeyPem,
          props.encryptionKey.keyId,
        )
        .then((r) => {
          progress.mark(1, "done", "JWE ready");
          return (r as { encrypted: string }).encrypted;
        }),
    ]);
    await props.finish({ mode: "dual-write", stripePmId: pm, jwe }, 2);
  };

  // proxy: Elements → BT token; backend → BT Proxy → Stripe pm_
  const proxyWrite = async () => {
    progress.start([
      "Tokenize card in Basis Theory (Elements)",
      "Create Stripe pm_ through the BT Proxy",
      "Start subscription",
    ]);
    const token = await bt!.tokens.create({
      type: "card",
      data: {
        number: cardRef.current,
        expiration_month: expiryRef.current!.month(),
        expiration_year: expiryRef.current!.year(),
        cvc: cvvRef.current,
      },
    });
    progress.mark(0, "done", (token as { id: string }).id);
    await props.finish(
      {
        mode: "proxy",
        btTokenId: (token as { id: string }).id,
        cardholderName: name,
      },
      1,
    );
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!bt) return;
    void props.run(cardWrite === "proxy" ? proxyWrite : dualWrite);
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>Card write mode</span>
        <span className="pill bg-zinc-100 font-mono text-zinc-700">
          {cardWrite}
        </span>
      </div>
      <div>
        <label className="label" htmlFor="cardholder">
          Name on card
        </label>
        <input
          id="cardholder"
          className="field"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div>
        <span className="label">Card number</span>
        <FieldShell focused={focus === "card"}>
          <CardNumberElement
            ref={cardRef}
            onFocus={() => setFocus("card")}
            onBlur={() => setFocus(null)}
            onChange={(e) =>
              setValid((v) => ({ ...v, card: e.detail.isValid }))
            }
          />
        </FieldShell>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <span className="label">Expiry</span>
          <FieldShell focused={focus === "expiry"}>
            <ExpiryElement
              ref={expiryRef}
              containerStyle={{ height: FIELD_HEIGHT }}
              onFocus={() => setFocus("expiry")}
              onBlur={() => setFocus(null)}
              onChange={(e) =>
                setValid((v) => ({ ...v, expiry: e.detail.isValid }))
              }
            />
          </FieldShell>
        </div>
        <div>
          <span className="label">CVC</span>
          <FieldShell focused={focus === "cvv"}>
            <CVVElement
              ref={cvvRef}
              containerStyle={{ height: FIELD_HEIGHT }}
              onFocus={() => setFocus("cvv")}
              onBlur={() => setFocus(null)}
              onChange={(e) =>
                setValid((v) => ({ ...v, cvv: e.detail.isValid }))
              }
            />
          </FieldShell>
        </div>
      </div>
      {blocked && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Basis Theory unavailable: proxy mode can&apos;t collect cards.
          Dual-write mode still would.
        </p>
      )}
      <button
        className="btn w-full"
        disabled={
          !bt ||
          !(valid.card && valid.expiry && valid.cvv) ||
          props.busy ||
          blocked
        }
        type="submit"
      >
        {props.busy ? "Processing…" : "Subscribe"}
      </button>
    </form>
  );
}

// Same border, radius and focus ring as the .field inputs
function FieldShell({
  focused,
  children,
}: {
  focused: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`h-[42px] overflow-hidden rounded-lg border bg-white transition ${
        focused ? "border-brand ring-2 ring-brand/20" : "border-zinc-300"
      }`}
    >
      {children}
    </div>
  );
}

function TabButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex-1 rounded-md px-3 py-1.5 transition disabled:opacity-40 ${active ? "bg-white shadow-sm" : "text-zinc-500"}`}
    >
      {children}
    </button>
  );
}

function errorMessage(err: unknown) {
  const e = err as {
    name?: string;
    status?: number;
    message?: string;
    data?: { error?: { param?: string; message?: string } };
  };
  if (e?.name === "HttpClientError") {
    if (e.status === -1) return "Stripe unreachable from Elements (allowlist?)";
    return `Stripe returned ${e.status}: ${e.data?.error?.message ?? "error"}`;
  }
  return e?.message ?? String(err);
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok)
    throw new Error(json.error ?? json.message ?? `HTTP ${res.status}`);
  return json;
}
