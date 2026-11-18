import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  country TEXT NOT NULL,
  currency TEXT NOT NULL,
  plan TEXT NOT NULL,
  phase TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_test_clock_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source TEXT NOT NULL,
  stripe_pm_id TEXT,
  bt_token_id TEXT,
  bt_token_status TEXT NOT NULL DEFAULT 'none',
  brand TEXT,
  last4 TEXT,
  nt_id TEXT,
  nt_number TEXT,
  nt_exp_month INTEGER,
  nt_exp_year INTEGER,
  nt_status TEXT NOT NULL DEFAULT 'none',
  nt_error TEXT,
  nti_pan TEXT,
  nti_nt TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pending_encrypted_cards (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL,
  jwe TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bt_keys (
  key_id TEXT PRIMARY KEY,
  public_key_pem TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS renewals (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  psp TEXT NOT NULL,
  credential TEXT NOT NULL,
  status TEXT NOT NULL,
  psp_ref TEXT,
  nti TEXT,
  error TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checkout_fulfillments (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  scope TEXT NOT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  ref TEXT,
  note TEXT,
  ms INTEGER,
  workspace_id TEXT
);
`;

const g = globalThis as unknown as { __db?: Database.Database; __dbPath?: string };

export function db(): Database.Database {
  if (g.__db && g.__dbPath === env.dbPath) return g.__db;
  if (env.dbPath !== ":memory:") fs.mkdirSync(path.dirname(env.dbPath), { recursive: true });
  const conn = new Database(env.dbPath);
  conn.pragma("journal_mode = WAL");
  conn.exec(SCHEMA);
  migrate(conn);
  g.__db = conn;
  g.__dbPath = env.dbPath;
  return conn;
}

// Columns added after the first local DBs were created
function migrate(conn: Database.Database) {
  const cols = (conn.prepare("PRAGMA table_info(renewals)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("attempt")) conn.exec("ALTER TABLE renewals ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1");
  if (!cols.includes("next_attempt_at")) conn.exec("ALTER TABLE renewals ADD COLUMN next_attempt_at TEXT");
}

export function resetDbHandle() {
  g.__db?.close();
  g.__db = undefined;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
