// Generates postman/*.json. Run: yarn postman:build
import fs from "node:fs";

type Header = { key: string; value: string };
interface Req {
  name: string;
  description: string;
  method: "GET" | "POST";
  url: string;
  headers?: Header[];
  json?: unknown;
  form?: Record<string, string>;
  capture?: Record<string, string>; // env var → JS expression on `json`
}

const bt = (key: string): Header => ({ key: "BT-API-KEY", value: `{{${key}}}` });
const stripeAuth: Header = { key: "Authorization", value: "Bearer {{stripe_secret_key}}" };

const folders: { name: string; description: string; items: Req[] }[] = [
  {
    name: "0 · Quick Start (Stripe Checkout + Forward)",
    description: "Cards keep being collected by Stripe Checkout. After the subscription CIT, the card is forwarded to the vault and a network token is provisioned.",
    items: [
      {
        name: "0.1 Stripe · Test card on file",
        description: "Stand-in for the card Stripe Checkout saved on the subscription.",
        method: "POST",
        url: "https://api.stripe.com/v1/payment_methods",
        headers: [stripeAuth],
        form: { type: "card", "card[token]": "tok_visa" },
        capture: { stripe_pm_id: "json.id" },
      },
      {
        name: "0.2 Stripe · Forward card to Basis Theory",
        description: "Stripe Vault and Forward. Requires Forwarding to be enabled on the Stripe account. Stripe replaces the empty card fields.",
        method: "POST",
        url: "https://api.stripe.com/v1/forwarding/requests",
        headers: [stripeAuth],
        form: {
          payment_method: "{{stripe_pm_id}}",
          url: "https://api.basistheory.com/connections/stripe-forward/tokenize",
          "request[headers][0][name]": "BT-API-KEY",
          "request[headers][0][value]": "{{bt_forward_api_key}}",
          "request[body]": JSON.stringify({
            card: { number: "", exp_month: "", exp_year: "", cvc: "", name: "" },
            metadata: { metadata: { stripe_pm: "{{stripe_pm_id}}", source: "quick-start" } },
          }),
          "replacements[0]": "card_number",
          "replacements[1]": "card_expiry",
          "replacements[2]": "card_cvc",
          "replacements[3]": "cardholder_name",
        },
        capture: { bt_token_id: "JSON.parse(json.response_details.body).id" },
      },
      {
        name: "0.3 BT · Stripe-forward endpoint (what Stripe delivers)",
        description: "The body Stripe delivers to BT in 0.2, sent by hand to try the BT side on its own.",
        method: "POST",
        url: "{{bt_api_url}}/connections/stripe-forward/tokenize",
        headers: [bt("bt_forward_api_key")],
        json: {
          card: { number: "4000000000000093", exp_month: "12", exp_year: "2030", cvc: "", name: "Jane Doe" },
          metadata: { metadata: { stripe_pm: "{{stripe_pm_id}}", source: "quick-start" } },
        },
        capture: { bt_token_id: "json.id" },
      },
      {
        name: "0.4 BT · Provision network token",
        description: "Sandbox only provisions its own test PANs; see the NT testing docs.",
        method: "POST",
        url: "{{bt_api_url}}/network-tokens",
        headers: [bt("bt_private_api_key")],
        json: { token_id: "{{bt_token_id}}", cardholder_info: { name: "Jane Doe" } },
        capture: { bt_network_token_id: "json.id" },
      },
      {
        name: "0.5 BT · Reveal network token (store it locally)",
        description: "Needs network-token:reveal. After this, MITs use the stored NT without calling Basis Theory.",
        method: "GET",
        url: "{{bt_api_url}}/network-tokens/{{bt_network_token_id}}",
        headers: [bt("bt_private_api_key")],
      },
    ],
  },
  {
    name: "1 · Phase 1(a) (Elements writes to Stripe + encrypts)",
    description: "Elements sends the card from its iframe straight to Stripe and encrypts a copy locally (JWE). The backend tokenizes the JWE now, or later if Basis Theory is down.",
    items: [
      {
        name: "1.1 BT · Status (health check)",
        description: "Public. The backend checks us.tokens before tokenizing; if false, JWE blobs are queued.",
        method: "GET",
        url: "{{bt_api_url}}/status?region=us",
      },
      {
        name: "1.2 BT · Create client encryption key (startup)",
        description: "Runs once at server start. The public key is only returned here; cache it for the checkout page.",
        method: "POST",
        url: "{{bt_api_url}}/keys",
        headers: [bt("bt_private_api_key")],
        json: {},
        capture: { bt_key_id: "json.key_id", bt_public_key_pem: "json.public_key_pem" },
      },
      {
        name: "1.3 Stripe · Create PaymentMethod with card data (what Elements sends)",
        description: "Elements' bt.client.post sends this from the BT iframe with the Stripe publishable key. Needs raw card data APIs enabled.",
        method: "POST",
        url: "https://api.stripe.com/v1/payment_methods",
        headers: [{ key: "Authorization", value: "Bearer {{stripe_publishable_key}}" }],
        form: {
          type: "card",
          "card[number]": "4000000000000093",
          "card[exp_month]": "12",
          "card[exp_year]": "2030",
          "card[cvc]": "123",
          "billing_details[name]": "Jane Doe",
        },
        capture: { stripe_pm_id: "json.id" },
      },
      {
        name: "1.4 BT · Create token from JWE",
        description: "Paste a JWE produced by bt.tokens.encrypt (or tests/fixtures makeJwe) into the jwe variable.",
        method: "POST",
        url: "{{bt_api_url}}/tokens",
        headers: [bt("bt_private_api_key")],
        json: { type: "card", encrypted: "{{jwe}}", metadata: { stripe_pm: "{{stripe_pm_id}}", source: "phase-1" } },
        capture: { bt_token_id: "json.id" },
      },
      {
        name: "1.5 Stripe · Charge the saved pm_ (backend, secret key)",
        description: "The backend, not Elements, creates and confirms the intent with the pm_ from 1.3. The app does this through the subscription's first invoice; this is the bare equivalent. requires_action → Stripe.js handleNextAction (3DS).",
        method: "POST",
        url: "https://api.stripe.com/v1/payment_intents",
        headers: [stripeAuth],
        form: {
          amount: "5000",
          currency: "usd",
          payment_method: "{{stripe_pm_id}}",
          confirm: "true",
          setup_future_usage: "off_session",
          return_url: "http://localhost:3000/phase-1/checkout",
          "expand[]": "latest_charge",
        },
        capture: { nti_pan: "json.latest_charge.payment_method_details.card.network_transaction_id" },
      },
      {
        name: "1.6 BT Proxy → Stripe · Create PaymentMethod from a token (proxy mode)",
        description: "Card write mode 'proxy': Elements tokenized the card (bt_token_id); the backend creates the Stripe pm_ through the BT Proxy. Basis Theory fills in the card data. Then charge it as in 1.5.",
        method: "POST",
        url: "{{bt_api_url}}/proxy",
        headers: [
          bt("bt_private_api_key"),
          { key: "BT-PROXY-URL", value: "https://api.stripe.com/v1/payment_methods" },
          stripeAuth,
        ],
        form: {
          type: "card",
          "card[number]": '{{ token: {{bt_token_id}} | json: "$.data.number" }}',
          "card[exp_month]": '{{ token: {{bt_token_id}} | json: "$.data" | card_exp: "MM" }}',
          "card[exp_year]": '{{ token: {{bt_token_id}} | json: "$.data" | card_exp: "YYYY" }}',
          "billing_details[name]": "Jane Doe",
        },
        capture: { stripe_pm_id: "json.id" },
      },
    ],
  },
  {
    name: "2 · Renewals",
    description: "Billing issues the invoice; the merchant charges it and marks it paid out of band. Primary: Stripe with NT + NTI (no BT call). Failover: Checkout.com via the BT Proxy.",
    items: [
      {
        name: "2.1 BT · Cryptogram (first NT charge only)",
        description: "Starts the NT transaction chain. Later MITs reference that chain's NTI.",
        method: "POST",
        url: "{{bt_api_url}}/network-tokens/{{bt_network_token_id}}/cryptogram",
        headers: [bt("bt_private_api_key")],
        json: {},
        capture: { cryptogram: "json.cryptogram", eci: "json.eci" },
      },
      {
        name: "2.2 Stripe · Charge NT + cryptogram (chain start)",
        description: "Network token passthrough must be enabled on the Stripe account. Sandbox NTs are simulated and may be rejected.",
        method: "POST",
        url: "https://api.stripe.com/v1/payment_intents",
        headers: [stripeAuth],
        form: {
          amount: "5000",
          currency: "usd",
          confirm: "true",
          off_session: "true",
          "payment_method_data[type]": "card",
          "payment_method_data[card][network_token][number]": "{{nt_number}}",
          "payment_method_data[card][network_token][exp_month]": "{{nt_exp_month}}",
          "payment_method_data[card][network_token][exp_year]": "{{nt_exp_year}}",
          "payment_method_options[card][network_token][cryptogram]": "{{cryptogram}}",
          "payment_method_options[card][network_token][electronic_commerce_indicator]": "{{eci}}",
          customer: "{{stripe_customer_id}}",
          "expand[]": "latest_charge",
        },
        capture: { nti_nt: "json.latest_charge.payment_method_details.card.network_transaction_id", stripe_payment_intent_id: "json.id" },
      },
      {
        name: "2.3 Stripe · MIT with NT + NTI",
        description: "Recurring charge referencing the NT chain. No Basis Theory call.",
        method: "POST",
        url: "https://api.stripe.com/v1/payment_intents",
        headers: [stripeAuth],
        form: {
          amount: "5000",
          currency: "usd",
          confirm: "true",
          off_session: "true",
          "payment_method_data[type]": "card",
          "payment_method_data[card][network_token][number]": "{{nt_number}}",
          "payment_method_data[card][network_token][exp_month]": "{{nt_exp_month}}",
          "payment_method_data[card][network_token][exp_year]": "{{nt_exp_year}}",
          "payment_method_options[card][mit_exemption][network_transaction_id]": "{{nti_nt}}",
          customer: "{{stripe_customer_id}}",
        },
        capture: { stripe_payment_intent_id: "json.id" },
      },
      {
        name: "2.4 Stripe · Attach the payment to the invoice",
        description: "A Stripe charge settles the invoice as a normal Stripe payment. Same customer and currency as the invoice; subscription uses collection_method=send_invoice.",
        method: "POST",
        url: "https://api.stripe.com/v1/invoices/{{stripe_invoice_id}}/attach_payment",
        headers: [stripeAuth],
        form: { payment_intent: "{{stripe_payment_intent_id}}" },
      },
      {
        name: "2.5 BT Proxy → Checkout.com · MIT failover",
        description: "When Stripe fails with a processor error or outage. The PAN is inserted by BT; only the token id and NTI leave the backend.",
        method: "POST",
        url: "{{bt_api_url}}/proxy",
        headers: [
          bt("bt_private_api_key"),
          { key: "BT-PROXY-URL", value: "{{cko_api_url}}/payments" },
          { key: "Authorization", value: "Bearer {{cko_secret_key}}" },
        ],
        json: {
          source: {
            type: "card",
            number: '{{ token: {{bt_token_id}} | json: "$.data.number" }}',
            expiry_month: '{{ token: {{bt_token_id}} | json: "$.data" | card_exp: "MM" }}',
            expiry_year: '{{ token: {{bt_token_id}} | json: "$.data" | card_exp: "YYYY" }}',
            stored: true,
          },
          amount: 5000,
          currency: "USD",
          processing_channel_id: "{{cko_processing_channel_id}}",
          payment_type: "Recurring",
          merchant_initiated: true,
          previous_payment_id: "{{nti_pan}}",
          reference: "{{stripe_invoice_id}}",
        },
      },
      {
        name: "2.6 Stripe · Mark invoice paid out of band",
        description: "Only after Checkout.com took the payment (2.5). Billing stays the system of record.",
        method: "POST",
        url: "https://api.stripe.com/v1/invoices/{{stripe_invoice_id}}/pay",
        headers: [stripeAuth],
        form: { paid_out_of_band: "true" },
      },
    ],
  },
  {
    name: "3 · Migration (one row of the dry run)",
    description: "What scripts/migration-dry-run.ts does per row of the Stripe export.",
    items: [
      {
        name: "3.1 BT · Tokenize an exported card",
        description: "Row from samples/stripe-export.sample.csv.",
        method: "POST",
        url: "{{bt_api_url}}/tokens",
        headers: [bt("bt_private_api_key")],
        json: {
          type: "card",
          data: { number: "4000000000000002", expiration_month: 12, expiration_year: 2030 },
          metadata: { stripe_customer: "cus_T1aSampleA001", stripe_card: "pm_1SampleCardA001", source: "migration" },
        },
        capture: { bt_token_id: "json.id" },
      },
      {
        name: "3.2 BT · Backfill network token",
        description: "Same call as 0.4, for an imported card.",
        method: "POST",
        url: "{{bt_api_url}}/network-tokens",
        headers: [bt("bt_private_api_key")],
        json: { token_id: "{{bt_token_id}}" },
        capture: { bt_network_token_id: "json.id" },
      },
    ],
  },
];

function toItem(r: Req) {
  const isJson = r.json !== undefined;
  const headers = [...(r.headers ?? [])];
  if (isJson) headers.push({ key: "Content-Type", value: "application/json" });
  const event = r.capture
    ? [
        {
          listen: "test",
          script: {
            type: "text/javascript",
            exec: [
              "const json = pm.response.json();",
              ...Object.entries(r.capture).map(([k, expr]) => `try { pm.environment.set("${k}", ${expr}); } catch (e) {}`),
            ],
          },
        },
      ]
    : undefined;
  return {
    name: r.name,
    event,
    request: {
      method: r.method,
      header: headers,
      description: r.description,
      url: r.url,
      body: isJson
        ? { mode: "raw", raw: JSON.stringify(r.json, null, 2), options: { raw: { language: "json" } } }
        : r.form
          ? { mode: "urlencoded", urlencoded: Object.entries(r.form).map(([key, value]) => ({ key, value })) }
          : undefined,
    },
  };
}

const collection = {
  info: {
    name: "Acme Builder · Vault-first payments POC",
    description: "Requests behind each step of the POC. Numbers match the guide and the app's step log.",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  item: folders.map((f) => ({ name: f.name, description: f.description, item: f.items.map(toItem) })),
};

const vars = [
  "bt_api_url=https://api.basistheory.com",
  "bt_private_api_key=",
  "bt_forward_api_key=",
  "stripe_secret_key=",
  "stripe_publishable_key=",
  "cko_api_url=https://api.sandbox.checkout.com",
  "cko_secret_key=",
  "cko_processing_channel_id=",
  "stripe_pm_id=",
  "stripe_customer_id=",
  "stripe_invoice_id=",
  "stripe_payment_intent_id=",
  "bt_token_id=",
  "bt_network_token_id=",
  "bt_key_id=",
  "bt_public_key_pem=",
  "jwe=",
  "nt_number=",
  "nt_exp_month=",
  "nt_exp_year=",
  "cryptogram=",
  "eci=",
  "nti_pan=",
  "nti_nt=",
];
const environment = {
  name: "Acme Builder · Sandbox",
  values: vars.map((v) => {
    const [key, ...rest] = v.split("=");
    return { key, value: rest.join("="), enabled: true, type: /key$/.test(key) ? "secret" : "default" };
  }),
};

fs.mkdirSync("postman", { recursive: true });
fs.writeFileSync("postman/acme-builder.postman_collection.json", JSON.stringify(collection, null, 2));
fs.writeFileSync("postman/acme-builder.postman_environment.json", JSON.stringify(environment, null, 2));
console.log(`postman: ${folders.reduce((n, f) => n + f.items.length, 0)} requests in ${folders.length} folders`);
