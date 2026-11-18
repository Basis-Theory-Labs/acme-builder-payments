# AGENTS.md

Brief for coding agents working in this repo. Read it before changing code.

## What this is

A subscription SaaS checkout (fictional "Acme Builder") that moves card ownership into a Basis Theory (BT) vault in steps, while Stripe Billing keeps plans and invoices.

| Flow | Entry | Core code |
|---|---|---|
| Quick Start: Stripe Checkout, then Stripe forwards the card to BT (success page + Events API sweep, no webhooks) | `app/quick-start/`, `app/api/quick-start/` | `lib/quick-start/checkout.ts`, `lib/quick-start/forward.ts`, `lib/quick-start/sweep.ts` |
| Phase 1(a): own checkout. Card via BT Elements in one of two modes, other methods via Stripe Elements | `app/phase-1/checkout/` | `lib/phase-1/cards.ts`, `lib/phase-1/subscribe.ts` |
| Card write mode `dual-write`: Elements → Stripe `/v1/payment_methods` + local JWE | `Phase1Checkout.tsx` | `lib/phase-1/cards.ts`, `lib/phase-1/reconcile.ts` |
| Card write mode `proxy`: Elements → BT token → BT Proxy → Stripe | `Phase1Checkout.tsx` | `lib/stripe-proxy.ts` |
| Phase 1(b): renewals. NT/`pm_` at Stripe, Checkout.com failover through the BT Proxy | `app/api/phase-1/webhooks/stripe/` | `lib/phase-1/renewals.ts`, `lib/checkoutcom.ts` |
| Phase 2: migration dry run | `scripts/migration-dry-run.ts` | `lib/migration.ts` |

Shared: `lib/bt.ts` (BT API), `lib/stripe.ts`, `lib/store.ts` (SQLite), `lib/settings.ts` (runtime switches, editable on `/ops`), `lib/log.ts` (step logger), `instrumentation.ts` (startup).

## Rules

- **Never log or persist card data in plaintext.** No PAN, CVC, NT number, cryptogram or JWE contents in logs. Use `step()`/`timed()` from `lib/log.ts` with ids only.
- **Stripe test mode only.** `lib/stripe.ts` refuses live keys. Keep it that way.
- **Browser → Stripe is only `POST /v1/payment_methods`** (publishable key). Intents and subscriptions are created and confirmed on the backend with the secret key. The browser uses Stripe.js only for Radar sessions and `handleNextAction`.
- **No BT API call on the checkout path in `dual-write` mode.** The encryption key is created at startup and read from SQLite.
- **No cross-PSP retry on issuer declines.** Only processor errors and outages fail over (`classifyStripeError` in `lib/stripe.ts`).
- One-line comments naming the step. Rationale goes in README.md.
- Every new flow gets an isolated test: set up preconditions through the API, run one step (see `tests/scenarios/`). Offline logic gets a unit test with mocked Stripe/BT (see `tests/unit/renewal-ladder.test.ts`).

## Common changes

- **Add a PSP for failover or routing:** copy `lib/checkoutcom.ts`. Build the PSP's request with `{{ token: <id> | json: "$.data.number" }}` expressions, send it with `proxy()` from `lib/bt.ts` (JSON or `URLSearchParams`), and add a branch in `renewInvoice` (`lib/phase-1/renewals.ts`). Add a unit test for the request body (no PAN) and a Postman request.
- **Add a Stripe payment method to the hybrid page:** enable it in the Stripe Dashboard (Settings → Payment methods). The Payment Element shows every enabled method except card (`excludedPaymentMethodTypes`). The backend accepts any `pm_` (`mode: "stripe"` in `ingestCard`); it stays at Stripe and renews on Billing.
- **Move wallets from Stripe to BT:** see the BT wallets skill below. Wallets live in `app/phase-1/checkout/StripeMethods.tsx` today.
- **New runtime switch:** add it to `DEFAULTS` in `lib/settings.ts`, to `/ops`, and to `.env.example`.

## Commands

```bash
yarn dev                        # app on :3000, step log in the terminal
yarn test:unit                  # offline
yarn test                       # + scenario tests for whichever sandbox keys are set
yarn typecheck
yarn migration:dry-run --mock
yarn postman:build              # regenerate postman/ after changing requests
```

## Basis Theory references

- Agent skills (start with `bt-start`): https://developers.basistheory.com/agent-skills/skills.md
  - Most relevant here: `bt-collect`, `bt-proxy`, `bt-payments`, `bt-network-tokens`, `bt-3ds`, `bt-wallets`, `bt-migrate`, `bt-production`.
- Docs index (look up URLs, don't guess them): https://developers.basistheory.com/llms.txt
