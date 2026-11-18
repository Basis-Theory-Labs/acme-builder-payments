import { env } from "../env";
import { timed } from "../log";
import { riskCheck } from "../risk";
import { priceIdFor, stripe } from "../stripe";
import { updateWorkspace, type Workspace } from "../store";

export async function ensureCustomer(ws: Workspace, opts: { testClock?: string } = {}): Promise<string> {
  if (ws.stripe_customer_id) return ws.stripe_customer_id;
  const customer = await timed(
    ws.phase,
    "stripe.customer.created",
    () =>
      stripe().customers.create({
        email: ws.email,
        name: `${ws.name} - ${ws.id}`,
        address: { country: ws.country },
        metadata: { workspace_id: ws.id },
        ...(opts.testClock ? { test_clock: opts.testClock } : {}),
      }),
    { ref: (c) => c.id, workspaceId: ws.id },
  );
  updateWorkspace(ws.id, { stripe_customer_id: customer.id });
  return customer.id;
}

// Same shape as today's hosted Checkout: subscription mode, customer per workspace, price by lookup key
export async function createCheckoutSession(ws: Workspace, riskToken?: string): Promise<string> {
  await riskCheck(ws.id, riskToken);
  const customer = await ensureCustomer(ws);
  const price = await priceIdFor(ws.plan, ws.currency);

  const session = await timed(
    "quick-start",
    "stripe.checkout.session.created",
    () =>
      stripe().checkout.sessions.create({
        mode: "subscription",
        customer,
        client_reference_id: ws.id,
        line_items: [{ price, quantity: 1 }],
        allow_promotion_codes: true,
        billing_address_collection: "required",
        subscription_data: { metadata: { workspace_id: ws.id, phase: "quick-start" } },
        metadata: { workspace_id: ws.id },
        success_url: `${env.appUrl}/quick-start/success?ws=${ws.id}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${env.appUrl}/?cancelled=1`,
      }),
    { ref: (s) => s.id, workspaceId: ws.id },
  );
  return session.url!;
}
