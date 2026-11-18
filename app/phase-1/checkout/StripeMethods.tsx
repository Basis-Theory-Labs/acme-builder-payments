"use client";

import { useMemo, useState } from "react";
import type { Stripe } from "@stripe/stripe-js";
import { Elements, ExpressCheckoutElement, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";

interface Common {
  stripePromise: Promise<Stripe | null>;
  amount: number;
  currency: string;
  onPaymentMethod: (pmId: string) => Promise<void>;
}

// Deferred-intent Elements: Stripe collects, we only create a pm_ here. The backend creates and confirms the intent.
// Methods come from the Stripe Dashboard (dynamic payment methods); excludeCard leaves cards to Basis Theory.
const options = (amount: number, currency: string, excludeCard = false) => ({
  mode: "subscription" as const,
  amount,
  currency,
  paymentMethodCreation: "manual" as const,
  ...(excludeCard ? { excludedPaymentMethodTypes: ["card"] } : {}),
});

export function WalletButtons(props: Common) {
  const opts = useMemo(() => options(props.amount, props.currency), [props.amount, props.currency]);
  return (
    <Elements stripe={props.stripePromise} options={opts}>
      <Wallets onPaymentMethod={props.onPaymentMethod} />
    </Elements>
  );
}

function Wallets({ onPaymentMethod }: Pick<Common, "onPaymentMethod">) {
  const stripe = useStripe();
  const elements = useElements();
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

  return (
    <ExpressCheckoutElement
      options={{ paymentMethods: { applePay: "always", googlePay: "always", link: "never", amazonPay: "never", klarna: "never", paypal: "never" } }}
      onReady={(e) => setHidden(!e.availablePaymentMethods)}
      onConfirm={async (event) => {
        if (!stripe || !elements) return;
        const { error: submitError } = await elements.submit();
        if (submitError) return event.paymentFailed({ reason: "fail" });
        const { paymentMethod, error } = await stripe.createPaymentMethod({ elements });
        if (error || !paymentMethod) return event.paymentFailed({ reason: "fail" });
        await onPaymentMethod(paymentMethod.id);
      }}
    />
  );
}

export function StripeMethodForm(props: Common & { busy: boolean }) {
  const opts = useMemo(() => options(props.amount, props.currency, true), [props.amount, props.currency]);
  return (
    <Elements stripe={props.stripePromise} options={opts}>
      <MethodForm onPaymentMethod={props.onPaymentMethod} busy={props.busy} />
    </Elements>
  );
}

function MethodForm({ onPaymentMethod, busy }: Pick<Common, "onPaymentMethod"> & { busy: boolean }) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setError(null);
    const { error: submitError } = await elements.submit();
    if (submitError) return setError(submitError.message ?? "Check the details");
    const { paymentMethod, error } = await stripe.createPaymentMethod({ elements });
    if (error || !paymentMethod) return setError(error?.message ?? "Could not create payment method");
    await onPaymentMethod(paymentMethod.id);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <PaymentElement onLoadError={(e) => setError(`Stripe couldn't load these methods: ${e.error.message ?? e.error.type}`)} />
      {error && <p className="text-sm text-red-700">{error}</p>}
      <button className="btn w-full" disabled={!stripe || busy} type="submit">
        {busy ? "Processing…" : "Subscribe"}
      </button>
    </form>
  );
}
