import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { BtError, createCardToken, provisionNetworkToken } from "./bt";

// Stripe card export (one row per card)
export const INPUT_COLUMNS = [
  "description",
  "name",
  "email",
  "id",
  "card.address_city",
  "card.address_country",
  "card.address_line1",
  "card.address_line2",
  "card.address_state",
  "card.address_zip",
  "card.exp_month",
  "card.exp_year",
  "card.id",
  "card.name",
  "card.number",
  "default_source",
  "card.transaction_ids",
  "card.transaction_link_id",
] as const;

// Import result: card.number becomes the vault token id, plus card details
export const IMPORT_COLUMNS = [...INPUT_COLUMNS, "brand", "bin", "last4", "funding", "fingerprint"];

// Step 2 output (network token backfill): the step 1 output with these columns appended.
// Token fields only when provisioning is created/deduplicated; a reason only when failed/token_not_found/skipped.
export const NT_COLUMNS = [
  ...IMPORT_COLUMNS,
  "network_token",
  "bt_network_token_id",
  "network_token_exp_month",
  "network_token_exp_year",
  "network_token_status",
  "network_token_provisioning_status",
  "network_token_provisioning_failed_reason",
];


type Row = Record<string, string>;

export interface Vault {
  tokenize(row: Row): Promise<{ id: string; brand: string; bin: string; last4: string; funding: string; fingerprint: string }>;
  networkTokenize(
    tokenId: string,
    row: Row,
  ): Promise<{ id: string; number: string; exp_month: number; exp_year: number; status: string; deduplicated?: boolean }>;
}

export function parseExport(csv: string): Row[] {
  return parse(csv, { columns: true, skip_empty_lines: true, trim: true }) as Row[];
}

export async function runMigration(rows: Row[], vault: Vault, onRow?: (row: Row, i: number) => void) {
  const imported: Row[] = [];
  const backfilled: Row[] = [];

  for (const [i, row] of rows.entries()) {
    const out: Row = { ...row };
    // No card number (e.g. a Link-only row): no token in step 1, every appended column blank in step 2
    if (!row["card.number"]) {
      imported.push({ ...out, "card.number": "" });
      backfilled.push({ ...out, "card.number": "" });
      continue;
    }

    const token = await vault.tokenize(row);
    Object.assign(out, {
      "card.number": token.id,
      brand: token.brand,
      bin: token.bin,
      last4: token.last4,
      funding: token.funding,
      fingerprint: token.fingerprint,
    });
    imported.push(out);

    const nt: Row = { ...out };
    try {
      const n = await vault.networkTokenize(token.id, row);
      Object.assign(nt, {
        network_token: n.number,
        bt_network_token_id: n.id,
        network_token_exp_month: String(n.exp_month),
        network_token_exp_year: String(n.exp_year),
        network_token_status: n.status,
        network_token_provisioning_status: n.deduplicated ? "deduplicated" : "created",
        network_token_provisioning_failed_reason: "",
      });
    } catch (err) {
      Object.assign(nt, {
        network_token_provisioning_status: "failed",
        network_token_provisioning_failed_reason: err instanceof BtError ? err.title : String(err),
      });
    }
    backfilled.push(nt);
    onRow?.(nt, i);
  }

  return {
    importCsv: stringify(imported, { header: true, columns: IMPORT_COLUMNS }),
    ntCsv: stringify(backfilled, { header: true, columns: NT_COLUMNS }),
    stats: {
      rows: rows.length,
      tokenized: imported.filter((r) => r.brand).length,
      ntSucceeded: backfilled.filter((r) => ["created", "deduplicated"].includes(r.network_token_provisioning_status)).length,
      ntFailed: backfilled.filter((r) => r.network_token_provisioning_status === "failed").length,
    },
  };
}

// ── Real sandbox ───────────────────────────────────────────────────────────

export const sandboxVault: Vault = {
  async tokenize(row) {
    const t = await createCardToken(
      { number: row["card.number"], expiration_month: Number(row["card.exp_month"]), expiration_year: Number(row["card.exp_year"]) },
      { stripe_customer: row.id, stripe_card: row["card.id"], source: "migration" },
    );
    const number = row["card.number"];
    return {
      id: t.id,
      brand: t.card?.brand ?? brandOf(number),
      bin: t.card?.bin ?? number.slice(0, 6),
      last4: t.card?.last4 ?? number.slice(-4),
      funding: t.card?.funding ?? "",
      fingerprint: t.fingerprint ?? "",
    };
  },
  async networkTokenize(tokenId, row) {
    const n = await provisionNetworkToken(tokenId, row["card.name"] || row.name || undefined);
    return {
      id: n.id,
      number: n.data.number,
      exp_month: n.data.expiration_month,
      exp_year: n.data.expiration_year,
      status: n.status,
      deduplicated: Boolean((n as { _extras?: { deduplicated?: boolean } })._extras?.deduplicated),
    };
  },
};

// ── Offline mock (deterministic, mirrors the NT sandbox: only its success cards provision) ─

const NT_SANDBOX_SUCCESS = new Set([
  "4000000000000002", "4000000000000085", "4000000000000093",
  "5100000000000008", "5100000000000065", "5100000000000073",
  "6011000000000004", "370000000000002", "370000000000069", "370000000000077",
]);

const NT_SANDBOX_ERRORS: Record<string, string> = {
  "4012888888881881": "PROVISION_DATA_EXPIRED",
  "5105105105105100": "PROVISION_DATA_EXPIRED",
  "4330251207506660": "CARD_VERIFICATION_FAILED",
  "4539097887163333": "CARD_NOT_ELIGIBLE",
  "5325191087030619": "CARD_NOT_ELIGIBLE",
  "4929980395567582": "CARD_NOT_ALLOWED",
  "4929544240318920": "CARD_DECLINED",
  "4916725297925395": "PROVISION_NOT_ALLOWED",
  "4711358892785746": "CARD_ELIGIBILITY_ERROR",
  "5555555555554444": "ISSUER_DECLINED",
};

function brandOf(pan: string) {
  if (pan.startsWith("4")) return "visa";
  if (/^(5[1-5]|2[2-7])/.test(pan)) return "mastercard";
  if (/^3[47]/.test(pan)) return "american-express";
  if (pan.startsWith("6")) return "discover";
  return "unknown";
}

const fakeUuid = (seed: string) => {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export const mockVault: Vault = {
  async tokenize(row) {
    const n = row["card.number"];
    return {
      id: fakeUuid(`tok:${row["card.id"]}`),
      brand: brandOf(n),
      bin: n.slice(0, 6),
      last4: n.slice(-4),
      funding: "credit",
      fingerprint: createHash("sha256").update(n).digest("base64url").slice(0, 44),
    };
  },
  async networkTokenize(tokenId, row) {
    if (!NT_SANDBOX_SUCCESS.has(row["card.number"])) {
      throw new BtError(422, NT_SANDBOX_ERRORS[row["card.number"]] ?? "CARD_DECLINED", null);
    }
    const pan = row["card.number"];
    const ntNumber = `${pan.slice(0, 1)}${createHash("sha256").update(tokenId).digest("hex").replace(/\D/g, "").slice(0, pan.length - 1)}`;
    return { id: fakeUuid(`nt:${tokenId}`), number: ntNumber, exp_month: 12, exp_year: 2030, status: "active" };
  },
};
