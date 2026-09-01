/**
 * ORCHESTRATOR + SHADOW HARNESS TESTS (§26/§27/§28/§29)
 */
import { describe, expect, it } from "vitest";
import { ParityCellRegistry } from "../cells/registry";
import { analyzeParityIntelligence } from "../orchestrator";
import { makeSyntheticSnapshots, runShadowReplay, summarizeShadowReplay } from "../shadow/harness";
import type { ReadonlySentinelProjection } from "../types";

function digitsFrom(seed: number, n: number): number[] {
  const out: number[] = [];
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(Math.floor(x / 65536) % 10);
  }
  return out;
}

const DIGITS = digitsFrom(11, 900);
const SNAPSHOTS = makeSyntheticSnapshots("R_100", DIGITS, { window: 600, steps: 6 });

const SENTINEL: readonly ReadonlySentinelProjection[] = Object.freeze([
  Object.freeze({
    cellId: "R_100::OVER_2",
    marketId: "R_100",
    proposition: "OVER 2",
    state: "OBSERVING",
    score: 72,
    isRipe: true,
    hardVetoActive: false,
    regimeCompatibility: "COMPATIBLE",
    identity: Object.freeze({
      winningDigits: Object.freeze([3, 4, 5, 6, 7, 8, 9]),
      losingDigits: Object.freeze([0, 1, 2]),
      greenParity: "ODD",
      secondGreenParity: "ODD",
      redParity: "EVEN",
      extremeDigit: 9,
      redExcludedDigit: 0,
      edgeGroup: Object.freeze([8, 9]),
    }),
  }) as ReadonlySentinelProjection,
]);

describe("analyzeParityIntelligence", () => {
  it("always maintains BOTH cells — the weaker hypothesis is never discarded", () => {
    const registry = new ParityCellRegistry();
    for (const s of SNAPSHOTS) analyzeParityIntelligence(s, { registry });
    const result = analyzeParityIntelligence(SNAPSHOTS[SNAPSHOTS.length - 1]!, { registry });
    expect(result.even.cellId).toBe("R_100_EVEN");
    expect(result.odd.cellId).toBe("R_100_ODD");
    expect(registry.getAllCells("R_100")).toHaveLength(2);
    expect(result.ranking).toHaveLength(2);
  });

  it("is deterministic for the same inputs and fresh state", () => {
    const a = analyzeParityIntelligence(SNAPSHOTS[0]!, { registry: new ParityCellRegistry() });
    const b = analyzeParityIntelligence(SNAPSHOTS[0]!, { registry: new ParityCellRegistry() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("produces an immutable snapshot", () => {
    const r = analyzeParityIntelligence(SNAPSHOTS[0]!);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.market)).toBe(true);
    expect(Object.isFrozen(r.source)).toBe(true);
    expect(() => {
      (r as { admission: string }).admission = "ADMITTED";
    }).toThrow();
    expect(() => {
      (r.reasoning as string[]).push("nope");
    }).toThrow();
  });

  it("re-running the same observation does not advance either cell", () => {
    const registry = new ParityCellRegistry();
    const first = analyzeParityIntelligence(SNAPSHOTS[0]!, { registry });
    const second = analyzeParityIntelligence(SNAPSHOTS[0]!, { registry });
    expect(second.even.observationCount).toBe(first.even.observationCount);
    expect(second.odd.observationCount).toBe(first.odd.observationCount);
    expect(second.even.persistenceTicks).toBe(first.even.persistenceTicks);
    expect(second.even.duplicateObservations).toBeGreaterThan(0);
  });

  it("never admits without a qualified cell and preserves the reasoning", () => {
    const r = analyzeParityIntelligence(SNAPSHOTS[0]!);
    if (r.admission === "NOT_ADMITTED") {
      expect(r.reasoning.length).toBeGreaterThan(0);
    }
    expect(["NO_VALID_SETUP", "DEVELOPING", "CANDIDATE", "QUALIFIED", "BLOCKED"]).toContain(
      r.qualification,
    );
  });

  it("cross-confirms read-only Sentinel projections without mutating them", () => {
    const before = JSON.stringify(SENTINEL);
    const r = analyzeParityIntelligence(SNAPSHOTS[0]!, { sentinel: SENTINEL });
    expect(JSON.stringify(SENTINEL)).toBe(before);
    expect(r.crossConfirmation).toHaveLength(1);
    expect(r.crossConfirmation[0]!.proposition).toBe("OVER 2");
  });

  it("keeps entry digit downstream of governance", () => {
    const r = analyzeParityIntelligence(SNAPSHOTS[0]!);
    if (r.qualification !== "QUALIFIED") {
      expect(r.entryDigit.evaluated).toBe(false);
      expect(r.dbot).toBeNull();
    }
  });
});

describe("shadow / replay harness", () => {
  it("replays without touching the live pipeline and summarizes", () => {
    const rows = runShadowReplay(SNAPSHOTS, {
      currentFor: () => ({ direction: "NO_TRADE", confidence: 0, admitted: false }),
      sentinelFor: () => SENTINEL,
    });
    expect(rows).toHaveLength(SNAPSHOTS.length);
    const summary = summarizeShadowReplay(rows);
    expect(summary.observations).toBe(SNAPSHOTS.length);
    expect(summary.agreementRate).not.toBeNull();
    expect(Object.isFrozen(rows)).toBe(true);
  });

  it("develops persistence across the replay (one shared registry)", () => {
    const rows = runShadowReplay(SNAPSHOTS);
    const last = rows[rows.length - 1]!.snapshot;
    expect(last.even.observationCount).toBe(SNAPSHOTS.length);
    expect(last.odd.observationCount).toBe(SNAPSHOTS.length);
  });

  it("is deterministic across identical replays", () => {
    const a = runShadowReplay(SNAPSHOTS).map((r) => r.newQualification);
    const b = runShadowReplay(SNAPSHOTS).map((r) => r.newQualification);
    expect(a).toEqual(b);
  });
});
