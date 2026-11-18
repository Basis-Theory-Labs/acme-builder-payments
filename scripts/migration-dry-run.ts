// Migration dry run, two steps: Stripe card export in → import output (step 1) → network token backfill (step 2).
//   yarn migration:dry-run --mock   (offline, deterministic)
//   yarn migration:dry-run          (real BT sandbox, needs BT_PRIVATE_API_KEY)
//   yarn migration:dry-run --input my.csv --out out/migration
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import pc from "picocolors";

if (fs.existsSync(".env.local")) process.loadEnvFile(".env.local");

const { mockVault, parseExport, runMigration, sandboxVault } = await import("../lib/migration");
const { step } = await import("../lib/log");

const { values } = parseArgs({
  options: {
    input: { type: "string", default: "samples/stripe-export.sample.csv" },
    out: { type: "string", default: "out/migration" },
    mock: { type: "boolean", default: false },
  },
});

const rows = parseExport(fs.readFileSync(values.input!, "utf8"));
const vault = values.mock ? mockVault : sandboxVault;
step("migration", "export.loaded", "info", { note: `${rows.length} rows · ${values.mock ? "mock vault" : "BT sandbox"}` });

const result = await runMigration(rows, vault, (row) => {
  if (!row.network_token_provisioning_status) return;
  const ok = ["created", "deduplicated"].includes(row.network_token_provisioning_status);
  step("migration", `${row["card.id"]}`, ok ? "ok" : "fail", {
    ref: row["card.number"],
    note: ok
      ? `${row.brand} •••• ${row.last4} → NT ${row.network_token_provisioning_status}`
      : `${row.brand} •••• ${row.last4} → ${row.network_token_provisioning_status} ${row.network_token_provisioning_failed_reason}`,
  });
});

fs.mkdirSync(values.out!, { recursive: true });
const base = path.basename(values.input!, ".csv").replace(/\.sample$/, "");
const files = {
  [`${base}.import-output.csv`]: result.importCsv,
  [`${base}.nt-backfill-output.csv`]: result.ntCsv,
};
for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(values.out!, name), content);

const s = result.stats;
console.log(`\n${pc.bold("Migration dry run")}  rows ${s.rows} · tokenized ${pc.green(String(s.tokenized))} · NT ${pc.green(String(s.ntSucceeded))} ok / ${pc.red(String(s.ntFailed))} failed`);
for (const name of Object.keys(files)) console.log(`  ${pc.dim("→")} ${path.join(values.out!, name)}`);
