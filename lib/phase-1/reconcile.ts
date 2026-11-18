import { createTokenFromJwe, isBtHealthy } from "../bt";
import { db } from "../db";
import { errorText, step, timed, type Scope } from "../log";
import { provisionAndStoreNt } from "../network-tokens";
import { getCredential, updateCredential } from "../store";

// Vaulting never runs while the customer waits. Checkout stores the JWE as "held"; once the subscription is
// active it becomes "queued", and vaultCredential() turns it into a BT token and a network token after the
// response. reconcilePending() is the backstop on a timer (BT was down, or the background run failed).

interface PendingRow {
  id: string;
  credential_id: string;
  jwe: string;
  attempts: number;
}

// Blobs from checkouts that never completed are dropped, never vaulted
const HELD_TTL = "-1 hour";

export function holdEncryptedCard(id: string, credentialId: string, jwe: string) {
  db().prepare("INSERT INTO pending_encrypted_cards (id, credential_id, jwe, status) VALUES (?, ?, ?, 'held')").run(id, credentialId, jwe);
}

// Subscription is active: the held blob may now be vaulted
export function releaseHeldCard(credentialId: string) {
  db().prepare("UPDATE pending_encrypted_cards SET status = 'queued' WHERE credential_id = ? AND status = 'held'").run(credentialId);
}

// One worker per blob: the background run and the reconciler can race
function claim(rowId: string): boolean {
  return db().prepare("UPDATE pending_encrypted_cards SET status = 'processing' WHERE id = ? AND status = 'queued'").run(rowId).changes === 1;
}

async function tokenizeRow(row: PendingRow, scope: Scope): Promise<boolean> {
  const cred = getCredential(row.credential_id);
  if (!cred || !claim(row.id)) return false;
  try {
    const token = await timed(
      scope,
      "bt.token.created (from jwe)",
      () => createTokenFromJwe(row.jwe, { stripe_pm: cred.stripe_pm_id ?? "", workspace_id: cred.workspace_id, source: "phase-1" }),
      { ref: (t) => t.id, workspaceId: cred.workspace_id },
    );
    updateCredential(cred.id, { bt_token_id: token.id, bt_token_status: "active" });
    db().prepare("UPDATE pending_encrypted_cards SET status = 'tokenized', jwe = '' WHERE id = ?").run(row.id);
    await provisionAndStoreNt({ ...cred, bt_token_id: token.id, bt_token_status: "active" }, scope);
    return true;
  } catch (err) {
    db()
      .prepare("UPDATE pending_encrypted_cards SET status = 'queued', attempts = attempts + 1, error = ? WHERE id = ?")
      .run(errorText(err), row.id);
    step(scope, "bt.token.failed", "fail", { note: `${errorText(err)} → reconciler retries`, workspaceId: cred.workspace_id });
    return false;
  }
}

// After checkout returns: JWE → BT token → network token (dual write), or just the network token (proxy)
export async function vaultCredential(credentialId: string): Promise<void> {
  const cred = getCredential(credentialId);
  if (!cred) return;
  const row = db()
    .prepare("SELECT id, credential_id, jwe, attempts FROM pending_encrypted_cards WHERE credential_id = ? AND status = 'queued'")
    .get(credentialId) as PendingRow | undefined;
  if (row) {
    if (!(await isBtHealthy())) {
      step("phase-1", "bt.status DOWN → jwe stays queued", "wait", { ref: row.id, workspaceId: cred.workspace_id });
      return;
    }
    await tokenizeRow(row, "phase-1");
    return;
  }
  if (cred.bt_token_status === "active" && cred.nt_status === "none") await provisionAndStoreNt(cred, "phase-1");
}

// Backstop: queued blobs whose background run didn't happen or failed
export async function reconcilePending(): Promise<{ tokenized: number; remaining: number }> {
  const dropped = db().prepare(`DELETE FROM pending_encrypted_cards WHERE status = 'held' AND created_at < datetime('now', '${HELD_TTL}')`).run().changes;
  if (dropped) step("reconcile", "jwe.dropped", "info", { note: `${dropped} blob(s) from checkouts that never completed` });

  const rows = db()
    .prepare("SELECT id, credential_id, jwe, attempts FROM pending_encrypted_cards WHERE status = 'queued' ORDER BY created_at")
    .all() as PendingRow[];
  if (!rows.length) return { tokenized: 0, remaining: 0 };

  if (!(await isBtHealthy())) {
    step("reconcile", "bt.status DOWN", "wait", { note: `${rows.length} blob(s) still queued` });
    return { tokenized: 0, remaining: rows.length };
  }

  let tokenized = 0;
  for (const row of rows) if (await tokenizeRow(row, "reconcile")) tokenized++;
  return { tokenized, remaining: rows.length - tokenized };
}
