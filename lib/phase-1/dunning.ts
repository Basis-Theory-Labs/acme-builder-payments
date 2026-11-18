import { errorText, step } from "../log";
import { dueRetries, recordRenewal } from "../store";
import { renewInvoice } from "./renewals";

// Runs soft-decline retries that are due. Each retry goes through the whole ladder again.
export async function retryDueRenewals(now = new Date()): Promise<number> {
  const due = dueRetries(now.toISOString());
  for (const r of due) {
    try {
      const result = await renewInvoice(r.invoice_id);
      // Invoice paid or voided elsewhere: close the retry so it isn't picked up again
      if (!result) {
        recordRenewal({ invoice_id: r.invoice_id, workspace_id: r.workspace_id, psp: r.psp, credential: r.credential, status: "retry_cancelled", psp_ref: null, nti: null, error: "invoice no longer open", attempt: r.attempt });
      }
    } catch (err) {
      step("renewal", "dunning.retry failed", "fail", { ref: r.invoice_id, note: errorText(err), workspaceId: r.workspace_id });
    }
  }
  return due.length;
}
