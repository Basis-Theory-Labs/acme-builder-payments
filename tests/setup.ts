import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";
import { resetDbHandle } from "@/lib/db";

for (const file of [".env.test.local", ".env.local"]) {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

// One throwaway SQLite file per test file
const dbFile = path.join("out", "test", `${crypto.randomUUID()}.db`);
process.env.DB_PATH = dbFile;
for (const key of ["SIMULATE_BT_DOWN", "SIMULATE_STRIPE_DOWN"]) process.env[key] = "false";

beforeAll(() => fs.mkdirSync(path.dirname(dbFile), { recursive: true }));
afterAll(() => {
  resetDbHandle();
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
});
