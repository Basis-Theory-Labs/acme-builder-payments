import pc from "picocolors";
import { db } from "./db";

export type Scope = "boot" | "quick-start" | "phase-1" | "renewal" | "reconcile" | "migration" | "ops";
export type Status = "ok" | "fail" | "wait" | "info" | "skip";

const ICON: Record<Status, string> = {
  ok: pc.green("✔"),
  fail: pc.red("✖"),
  wait: pc.yellow("⏸"),
  info: pc.cyan("•"),
  skip: pc.gray("↷"),
};

export interface StepFields {
  ref?: string | null;
  note?: string;
  ms?: number;
  workspaceId?: string;
}

// Shortens ids for display: pm_1QabcdEF…a9
export function short(id?: string | null): string {
  if (!id) return "";
  return id.length > 14 ? `${id.slice(0, 9)}…${id.slice(-3)}` : id;
}

export function step(scope: Scope, name: string, status: Status, f: StepFields = {}) {
  const tag = pc.dim(`[${scope}]`.padEnd(14));
  const padded = name.padEnd(32);
  const label = status === "fail" ? pc.red(padded) : pc.bold(padded);
  const parts = [tag, ICON[status], label];
  if (f.note) parts.push(status === "fail" ? pc.red(f.note) : f.note);
  if (f.ref) parts.push(pc.magenta(short(f.ref)));
  if (f.ms !== undefined) parts.push(pc.dim(`${f.ms}ms`));
  console.log(parts.join("  "));

  try {
    db()
      .prepare(
        "INSERT INTO events (scope, step, status, ref, note, ms, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(scope, name, status, short(f.ref) || null, f.note ?? null, f.ms ?? null, f.workspaceId ?? null);
  } catch {
    // event feed is best effort
  }
}

// Runs fn and logs one line with its duration. ref(result) picks the id to show.
export async function timed<T>(
  scope: Scope,
  name: string,
  fn: () => Promise<T>,
  opts: { ref?: (r: T) => string | null | undefined; workspaceId?: string; note?: (r: T) => string | undefined } = {},
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    step(scope, name, "ok", {
      ref: opts.ref?.(result),
      note: opts.note?.(result),
      ms: Date.now() - start,
      workspaceId: opts.workspaceId,
    });
    return result;
  } catch (err) {
    step(scope, name, "fail", { note: errorText(err), ms: Date.now() - start, workspaceId: opts.workspaceId });
    throw err;
  }
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
