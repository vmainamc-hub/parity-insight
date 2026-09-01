/**
 * GOVERNANCE TESTS (§29) — hard vetoes, ranking purity, three questions.
 */
import { describe, expect, it } from "vitest";
import { ParityCell } from "../cells/cell";
import { evaluateGates } from "../governance/gates";
import { cellStrength, rankCells, strongestCell } from "../governance/ranking";
import type { EntryDigitReadiness, HardVeto, ParityCellSnapshot } from "../types";
import { ctx, evenEvidence, evidence, observation } from "./fixtures";

const oddEvidence = [
  evidence("stats", "ODD"),
  evidence("markov", "ODD"),
  evidence("pressure", "ODD"),
];

const READY_DIGIT: EntryDigitReadiness = Object.freeze({
  evaluated: true,
  reason: "ready",
  targetContract: "DIGITEVEN",
  entryDigit: 7,
  confidence: 70,
  status: "READY",
}) as EntryDigitReadiness;

const NO_DIGIT: EntryDigitReadiness = Object.freeze({
  evaluated: false,
  reason: "not evaluated",
  targetContract: null,
  entryDigit: null,
  confidence: 0,
  status: null,
}) as EntryDigitReadiness;

function grow(
  parity: "EVEN" | "ODD",
  ticks: number,
  over: Parameters<typeof observation>[3] = {},
): ParityCellSnapshot {
  const cell = new ParityCell("R_100", parity);
  for (let i = 1; i <= ticks; i++) {
    cell.ingest(observation(parity, i, parity === "EVEN" ? evenEvidence : oddEvidence, over));
  }
  return cell.snapshot();
}

const VETO: HardVeto = Object.freeze({
  code: "TEST_HARD_VETO",
  engine: "danger",
  reason: "catastrophic danger",
  parity: null,
});

describe("hard governance authority", () => {
  it("a hard veto cannot be overridden by a high weighted score", () => {
    const strong = grow("EVEN", 10);
    const vetoed: ParityCellSnapshot = { ...strong, hardVetoes: [VETO] };
    expect(cellStrength(vetoed)).toBeGreaterThan(50); // still the strongest hypothesis
    const gates = evaluateGates({
      cell: vetoed,
      strength: 100,
      crossConfirmation: [],
      entryDigit: READY_DIGIT,
      requireCrossConfirmation: false,
    });
    expect(gates.qualification).toBe("BLOCKED");
    expect(gates.admission).toBe("NOT_ADMITTED");
    expect(gates.blockingCodes).toContain("TEST_HARD_VETO");
  });

  it("an incompatible regime blocks even a well-developed cell", () => {
    const cell = grow("EVEN", 10, {
      context: ctx({ regimeCompatible: { EVEN: false, ODD: true } }),
    });
    const gates = evaluateGates({
      cell,
      strength: 99,
      crossConfirmation: [],
      entryDigit: READY_DIGIT,
      requireCrossConfirmation: false,
    });
    expect(gates.qualification).toBe("BLOCKED");
    expect(gates.blockingCodes).toContain("REGIME_INCOMPATIBLE");
  });

  it("no observation means NO_VALID_SETUP, never a forced signal", () => {
    const gates = evaluateGates({
      cell: null,
      strength: 0,
      crossConfirmation: [],
      entryDigit: NO_DIGIT,
      requireCrossConfirmation: false,
    });
    expect(gates.qualification).toBe("NO_VALID_SETUP");
    expect(gates.admission).toBe("NOT_ADMITTED");
  });

  it("qualified is still not admitted without an entry digit", () => {
    const cell = grow("EVEN", 10);
    const gates = evaluateGates({
      cell,
      strength: 80,
      crossConfirmation: [],
      entryDigit: NO_DIGIT,
      requireCrossConfirmation: false,
    });
    expect(["QUALIFIED", "CANDIDATE"]).toContain(gates.qualification);
    expect(gates.admission).toBe("NOT_ADMITTED");
  });

  it("an immature cell cannot qualify on one strong tick", () => {
    const cell = grow("EVEN", 1);
    const gates = evaluateGates({
      cell,
      strength: 90,
      crossConfirmation: [],
      entryDigit: READY_DIGIT,
      requireCrossConfirmation: false,
    });
    expect(["DEVELOPING", "NO_VALID_SETUP"]).toContain(gates.qualification);
    expect(gates.blockingCodes).toContain("IMMATURE");
  });
});

describe("ranking is pure and separate from qualification", () => {
  it("does not ingest or mutate cell state", () => {
    const cell = new ParityCell("R_100", "EVEN");
    for (let i = 1; i <= 5; i++) cell.ingest(observation("EVEN", i, evenEvidence));
    const before = cell.snapshot();
    const odd = new ParityCell("R_100", "ODD").snapshot();
    rankCells(before, odd);
    rankCells(before, odd);
    const after = cell.snapshot();
    expect(after.observationCount).toBe(before.observationCount);
    expect(after.persistenceTicks).toBe(before.persistenceTicks);
    expect(after.confidence).toBe(before.confidence);
  });

  it("is deterministic and frozen", () => {
    const even = grow("EVEN", 6);
    const odd = grow("ODD", 6);
    const a = rankCells(even, odd);
    expect(rankCells(even, odd)).toEqual(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(a[0]!.rank).toBe(1);
    expect(a[1]!.rank).toBe(2);
  });

  it("keeps a #1 cell visible even while it is blocked", () => {
    const even = grow("EVEN", 8);
    const blocked: ParityCellSnapshot = { ...even, hardVetoes: [VETO] };
    const odd = new ParityCell("R_100", "ODD").snapshot();
    const ranking = rankCells(blocked, odd);
    expect(strongestCell(ranking)).toBe("EVEN");
    expect(ranking[0]!.blocked).toBe(true);
  });

  it("returns no strongest cell when both cells are empty", () => {
    const even = new ParityCell("R_100", "EVEN").snapshot();
    const odd = new ParityCell("R_100", "ODD").snapshot();
    expect(strongestCell(rankCells(even, odd))).toBeNull();
  });
});
