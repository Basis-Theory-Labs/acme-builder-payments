import fs from "node:fs";
import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import { IMPORT_COLUMNS, mockVault, NT_COLUMNS, parseExport, runMigration } from "@/lib/migration";

const rows = parseExport(fs.readFileSync("samples/stripe-export.sample.csv", "utf8"));

describe("migration dry run (mock vault)", async () => {
  const result = await runMigration(rows, mockVault);
  const imported = parse(result.importCsv, { columns: true }) as Record<string, string>[];
  const nt = parse(result.ntCsv, { columns: true }) as Record<string, string>[];

  it("keeps the export columns and appends the documented ones", () => {
    expect(Object.keys(imported[0])).toEqual(IMPORT_COLUMNS);
    expect(Object.keys(nt[0])).toEqual(NT_COLUMNS);
  });

  it("replaces every PAN with a token id", () => {
    for (const r of imported) expect(r["card.number"]).not.toMatch(/^\d{13,19}$/);
  });

  it("keeps rows without a card number (e.g. Link-only) with every appended column blank", () => {
    expect(imported.find((r) => r["card.id"] === "pm_1SampleLinkI010")?.["card.number"]).toBe("");
    const linkRow = nt.find((r) => r["card.id"] === "pm_1SampleLinkI010")!;
    expect(linkRow.network_token_provisioning_status).toBe("");
    expect(linkRow.bt_network_token_id).toBe("");
  });

  it("follows the NT file contract: token fields only when created, a reason only when failed", () => {
    for (const r of nt.filter((r) => r["card.number"])) {
      if (r.network_token_provisioning_status === "created") {
        expect(r.bt_network_token_id).not.toBe("");
        expect(r.network_token_provisioning_failed_reason).toBe("");
      } else {
        expect(r.network_token_provisioning_status).toBe("failed");
        expect(r.bt_network_token_id).toBe("");
        expect(r.network_token).toBe("");
        expect(r.network_token_provisioning_failed_reason).not.toBe("");
      }
    }
  });

  it("reports NT sandbox error cards with their failure reason", () => {
    const failed = nt.filter((r) => r.network_token_provisioning_status === "failed").map((r) => r.network_token_provisioning_failed_reason);
    expect(failed.sort()).toEqual(["CARD_DECLINED", "CARD_NOT_ELIGIBLE", "ISSUER_DECLINED", "PROVISION_DATA_EXPIRED"]);
  });

  it("keeps the Stripe ids next to the vault token and network token on each row", () => {
    const a = nt.find((r) => r["card.id"] === "pm_1SampleCardA001")!;
    expect(a).toMatchObject({ id: "cus_T1aSampleA001", default_source: "pm_1SampleCardA001", "card.transaction_ids": "483298123456789" });
    expect(a["card.number"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.bt_network_token_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
