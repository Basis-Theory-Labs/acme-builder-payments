import { describe, expect, it } from "vitest";
import { bucket, phaseFor } from "@/lib/rollout";

describe("rollout", () => {
  it("buckets are stable per workspace", () => {
    expect(bucket("ws_abc")).toBe(bucket("ws_abc"));
  });

  it("percentage split lands close to target", () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `ws_${i}`);
    const share = ids.filter((id) => phaseFor({ id, country: "US" }, { percent: 25, countries: [] }) === "phase-1").length / ids.length;
    expect(share).toBeGreaterThan(0.22);
    expect(share).toBeLessThan(0.28);
  });

  it("country list always wins", () => {
    expect(phaseFor({ id: "ws_1", country: "br" }, { percent: 0, countries: ["BR"] })).toBe("phase-1");
  });

  it("0% and no countries keeps everyone on Quick Start", () => {
    expect(phaseFor({ id: "ws_1", country: "US" }, { percent: 0, countries: [] })).toBe("quick-start");
  });

  it("100% moves everyone to Phase 1", () => {
    expect(phaseFor({ id: "ws_1", country: "US" }, { percent: 100, countries: [] })).toBe("phase-1");
  });
});
