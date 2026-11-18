import { proxy } from "./bt";
import { env, required } from "./env";

export interface CkoPayment {
  id: string;
  approved: boolean;
  status: string;
  response_code?: string;
  response_summary?: string;
  scheme_id?: string;
}

const tokenExpr = (tokenId: string, path: string, filter = "") =>
  `{{ token: ${tokenId} | json: "${path}"${filter ? ` | ${filter}` : ""} }}`;

// MIT at Checkout.com through the BT Proxy. The PAN is filled in by BT; this service only holds the token id.
export async function chargeRecurringViaProxy(opts: {
  tokenId: string;
  amount: number;
  currency: string;
  previousNti: string | null;
  reference: string;
}): Promise<{ status: number; payment: CkoPayment }> {
  const body = {
    source: {
      type: "card",
      number: tokenExpr(opts.tokenId, "$.data.number"),
      expiry_month: tokenExpr(opts.tokenId, "$.data", 'card_exp: "MM"'),
      expiry_year: tokenExpr(opts.tokenId, "$.data", 'card_exp: "YYYY"'),
      stored: true,
    },
    amount: opts.amount,
    currency: opts.currency.toUpperCase(),
    processing_channel_id: required("ckoProcessingChannelId"),
    payment_type: "Recurring",
    merchant_initiated: true,
    ...(opts.previousNti ? { previous_payment_id: opts.previousNti } : {}),
    reference: opts.reference,
  };

  const res = await proxy<CkoPayment>(`${env.ckoApiUrl}/payments`, body, {
    Authorization: `Bearer ${required("ckoSecretKey")}`,
  });
  return { status: res.status, payment: res.body };
}
