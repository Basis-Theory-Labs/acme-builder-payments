import { BtError, provisionNetworkToken, revealNetworkToken } from "./bt";
import { step, timed, type Scope } from "./log";
import { updateCredential, type Credential } from "./store";

// Provision an NT for the credential's BT token, reveal it once, and store it locally.
// From here on, MITs use the stored NT directly at the PSP without calling BT.
export async function provisionAndStoreNt(cred: Credential, scope: Scope, cardholderName?: string): Promise<Credential> {
  if (!cred.bt_token_id) {
    step(scope, "bt.nt.skipped", "skip", { note: "no BT token yet", workspaceId: cred.workspace_id });
    return cred;
  }
  try {
    const nt = await timed(scope, "bt.nt.provisioned", () => provisionNetworkToken(cred.bt_token_id!, cardholderName), {
      ref: (r) => r.id,
      note: (r) => r.status,
      workspaceId: cred.workspace_id,
    });
    const revealed = await timed(scope, "bt.nt.revealed", () => revealNetworkToken(nt.id), {
      note: (r) => `stored locally, exp ${r.data.expiration_month}/${r.data.expiration_year}`,
      workspaceId: cred.workspace_id,
    });
    const fields = {
      nt_id: nt.id,
      nt_number: revealed.data.number,
      nt_exp_month: revealed.data.expiration_month,
      nt_exp_year: revealed.data.expiration_year,
      nt_status: "active" as const,
      nt_error: null,
    };
    updateCredential(cred.id, fields);
    return { ...cred, ...fields };
  } catch (err) {
    const title = err instanceof BtError ? err.title : String(err);
    updateCredential(cred.id, { nt_status: "failed", nt_error: title });
    step(scope, "bt.nt.unavailable", "info", {
      note: `${title} → MITs use the PSP card on file`,
      workspaceId: cred.workspace_id,
    });
    return { ...cred, nt_status: "failed", nt_error: title };
  }
}
