import { db, newId } from "./db";
import type { Phase } from "./rollout";

export interface Workspace {
  id: string;
  name: string;
  email: string;
  country: string;
  currency: string;
  plan: string;
  phase: Phase;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_test_clock_id: string | null;
}

export interface Credential {
  id: string;
  workspace_id: string;
  source: "quick-start" | "phase-1" | "migration";
  stripe_pm_id: string | null;
  bt_token_id: string | null;
  bt_token_status: "none" | "pending" | "active";
  brand: string | null;
  last4: string | null;
  nt_id: string | null;
  nt_number: string | null;
  nt_exp_month: number | null;
  nt_exp_year: number | null;
  nt_status: "none" | "active" | "failed";
  nt_error: string | null;
  nti_pan: string | null;
  nti_nt: string | null;
}

export function createWorkspace(w: Omit<Workspace, "id" | "stripe_customer_id" | "stripe_subscription_id" | "stripe_test_clock_id"> & { id?: string }): Workspace {
  const id = w.id ?? newId("ws");
  db()
    .prepare("INSERT INTO workspaces (id, name, email, country, currency, plan, phase) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, w.name, w.email, w.country, w.currency, w.plan, w.phase);
  return getWorkspace(id)!;
}

export function getWorkspace(id: string): Workspace | undefined {
  return db().prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Workspace | undefined;
}

export function getWorkspaceByCustomer(customerId: string): Workspace | undefined {
  return db().prepare("SELECT * FROM workspaces WHERE stripe_customer_id = ?").get(customerId) as Workspace | undefined;
}

export function updateWorkspace(id: string, fields: Partial<Workspace>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db()
    .prepare(`UPDATE workspaces SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`)
    .run({ ...fields, id });
}

export function listWorkspaces(limit = 20): Workspace[] {
  return db().prepare("SELECT * FROM workspaces ORDER BY created_at DESC LIMIT ?").all(limit) as Workspace[];
}

export function createCredential(c: Partial<Credential> & Pick<Credential, "workspace_id" | "source">): Credential {
  const id = newId("cred");
  const row = { id, ...c };
  const keys = Object.keys(row);
  db()
    .prepare(`INSERT INTO credentials (${keys.join(", ")}) VALUES (${keys.map((k) => `@${k}`).join(", ")})`)
    .run(row);
  return getCredential(id)!;
}

export function getCredential(id: string): Credential | undefined {
  return db().prepare("SELECT * FROM credentials WHERE id = ?").get(id) as Credential | undefined;
}

export function latestCredential(workspaceId: string): Credential | undefined {
  return db()
    .prepare("SELECT * FROM credentials WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(workspaceId) as Credential | undefined;
}

export function updateCredential(id: string, fields: Partial<Credential>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db()
    .prepare(
      `UPDATE credentials SET ${keys.map((k) => `${k} = @${k}`).join(", ")}, updated_at = datetime('now') WHERE id = @id`,
    )
    .run({ ...fields, id });
}

export function listCredentials(limit = 50): (Credential & { workspace_name: string })[] {
  return db()
    .prepare(
      "SELECT c.*, w.name AS workspace_name FROM credentials c JOIN workspaces w ON w.id = c.workspace_id ORDER BY c.created_at DESC, c.rowid DESC LIMIT ?",
    )
    .all(limit) as (Credential & { workspace_name: string })[];
}

export interface EventRow {
  id: number;
  ts: string;
  scope: string;
  step: string;
  status: string;
  ref: string | null;
  note: string | null;
  ms: number | null;
  workspace_id: string | null;
}

export function listEvents(opts: { workspaceId?: string; limit?: number } = {}): EventRow[] {
  const limit = opts.limit ?? 100;
  if (opts.workspaceId) {
    return db()
      .prepare("SELECT * FROM events WHERE workspace_id = ? ORDER BY id DESC LIMIT ?")
      .all(opts.workspaceId, limit) as EventRow[];
  }
  return db().prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as EventRow[];
}

export interface RenewalRow {
  id: string;
  invoice_id: string;
  workspace_id: string;
  psp: string;
  credential: string;
  status: string;
  psp_ref: string | null;
  nti: string | null;
  error: string | null;
  attempt: number;
  next_attempt_at: string | null;
  created_at: string;
}

export function recordRenewal(
  r: Omit<RenewalRow, "id" | "created_at" | "attempt" | "next_attempt_at"> & { attempt?: number; next_attempt_at?: string | null },
): RenewalRow {
  const id = newId("ren");
  db()
    .prepare(
      "INSERT INTO renewals (id, invoice_id, workspace_id, psp, credential, status, psp_ref, nti, error, attempt, next_attempt_at) VALUES (@id, @invoice_id, @workspace_id, @psp, @credential, @status, @psp_ref, @nti, @error, @attempt, @next_attempt_at)",
    )
    .run({ id, attempt: 1, next_attempt_at: null, ...r });
  return db().prepare("SELECT * FROM renewals WHERE id = ?").get(id) as RenewalRow;
}

// Soft declines already scheduled for this invoice, oldest first
export function scheduledRetries(invoiceId: string): RenewalRow[] {
  return db()
    .prepare("SELECT * FROM renewals WHERE invoice_id = ? AND status = 'retry_scheduled' ORDER BY rowid")
    .all(invoiceId) as RenewalRow[];
}

// Invoices whose latest renewal is a retry that is due
export function dueRetries(nowIso: string): RenewalRow[] {
  return db()
    .prepare(
      `SELECT r.* FROM renewals r
       WHERE r.status = 'retry_scheduled' AND r.next_attempt_at <= ?
         AND NOT EXISTS (SELECT 1 FROM renewals later WHERE later.invoice_id = r.invoice_id AND later.rowid > r.rowid)`,
    )
    .all(nowIso) as RenewalRow[];
}

export function listRenewals(limit = 30): RenewalRow[] {
  return db().prepare("SELECT * FROM renewals ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as RenewalRow[];
}

// One fulfillment per Checkout Session, whichever trigger gets there first
export function claimCheckoutSession(sessionId: string, workspaceId: string, trigger: string): boolean {
  const res = db()
    .prepare("INSERT OR IGNORE INTO checkout_fulfillments (session_id, workspace_id, trigger) VALUES (?, ?, ?)")
    .run(sessionId, workspaceId, trigger);
  return res.changes === 1;
}

export function isCheckoutSessionClaimed(sessionId: string): boolean {
  return Boolean(db().prepare("SELECT 1 FROM checkout_fulfillments WHERE session_id = ?").get(sessionId));
}

export function releaseCheckoutSession(sessionId: string) {
  db().prepare("DELETE FROM checkout_fulfillments WHERE session_id = ?").run(sessionId);
}
