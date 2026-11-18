import { ensureEncryptionKey } from "./bt";
import { errorText, step } from "./log";
import { retryDueRenewals } from "./phase-1/dunning";
import { reconcilePending } from "./phase-1/reconcile";
import { sweepCompletedCheckouts } from "./quick-start/sweep";

const g = globalThis as unknown as { __booted?: boolean };

// Runs once at server start: encryption key ready before any checkout renders, reconciler, checkout sweep and dunning on a timer
export async function bootstrap() {
  if (g.__booted) return;
  g.__booted = true;

  await ensureKeyWithRetry();

  setInterval(() => {
    reconcilePending().catch((err) => step("reconcile", "run", "fail", { note: errorText(err) }));
  }, 30_000).unref();
  step("boot", "reconciler.scheduled", "info", { note: "every 30s" });

  setInterval(() => {
    sweepCompletedCheckouts().catch((err) => step("quick-start", "events-sweep", "fail", { note: errorText(err) }));
  }, 30_000).unref();
  step("boot", "checkout-sweep.scheduled", "info", { note: "every 30s, sessions older than 2 min" });

  setInterval(() => {
    retryDueRenewals().catch((err) => step("renewal", "dunning.run", "fail", { note: errorText(err) }));
  }, 30_000).unref();
  step("boot", "dunning.scheduled", "info", { note: "every 30s, soft-decline retries that are due" });
}

async function ensureKeyWithRetry(attempt = 1): Promise<void> {
  try {
    await ensureEncryptionKey();
  } catch (err) {
    const wait = Math.min(60, 5 * attempt);
    step("boot", "bt.key unavailable", "fail", { note: `${errorText(err)}, retrying in ${wait}s` });
    setTimeout(() => void ensureKeyWithRetry(attempt + 1), wait * 1000).unref();
  }
}
