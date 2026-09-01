/**
 * SENTINEL BRIDGE TESTS (§29)
 * Read-only, deterministic, proposition-aware parity mapping.
 */
import { describe, expect, it } from "vitest";
import { ParityCell } from "../cells/cell";
import { crossConfirm, crossConfirmAll, cellSupportLevel } from "../sentinel/bridge";
import { projectSentinelDossier, type ProjectableDossier } from "../sentinel/projection";
import type { ReadonlySentinelProjection } from "../types";
import { evenEvidence, evidence, observation } from "./fixtures";

function projection(
  over: Partial<ReadonlySentinelProjection> & {
    identity?: Partial<ReadonlySentinelProjection["identity"]>;
  } = {},
): ReadonlySentinelProjection {
  return {
    cellId: "R_100::OVER_2",
    marketId: "R_100",
    proposition: "OVER 2",
    state: "OBSERVING",
    score: 70,
    isRipe: true,
    hardVetoActive: false,
    regimeCompatibility: "COMPATIBLE",
    ...over,
    identity: {
      // OVER 2 -> winning digits 3..9: 3 even (4,6,8) / 4 odd (3,5,7,9)
      winningDigits: [3, 4, 5, 6, 7, 8, 9],
      losingDigits: [0, 1, 2],
      greenParity: "ODD",
      secondGreenParity: "ODD",
      redParity: "EVEN",
      extremeDigit: 9,
      redExcludedDigit: 0,
      edgeGroup: [8, 9],
      ...(over.identity ?? {}),
    },
  };
}

function maturedCell(parity: "EVEN" | "ODD", ticks = 8) {
  const cell = new ParityCell("R_100", parity);
  for (let i = 1; i <= ticks; i++) {
    cell.ingest(observation(parity, i, parity === "EVEN" ? evenEvidence : oddEvidence));
  }
  return cell.snapshot();
}

const oddEvidence = [evidence("stats", "ODD"), evidence("markov", "ODD"), evidence("pressure", "ODD")];

const emptyEven = new ParityCell("R_100", "EVEN").snapshot();
const emptyOdd = new ParityCell("R_100", "ODD").snapshot();

describe("sentinel projection", () => {
  it("never fabricates identity when the dossier has none", () => {
    const dossier = {
      cellId: "x",
      marketId: "R_100",
      proposition: "OVER 2",
      state: "OBSERVING",
      score: 10,
      isRipe: false,
    } as unknown as ProjectableDossier;
    expect(projectSentinelDossier(dossier)).toBeNull();
  });

  it("produces a frozen projection that cannot mutate Sentinel", () => {
    const identity = {
      winningDigits: [3, 4, 5],
      losingDigits: [0, 1, 2],
      greenParity: "ODD",
      secondGreenParity: "ODD",
      redParity: "EVEN",
      extremeDigit: 9,
      redExcludedDigit: 0,
      edgeGroup: [8, 9],
    };
    const dossier = {
      cellId: "x",
      marketId: "R_100",
      proposition: "OVER 2",
      state: "OBSERVING",
      score: 10,
      isRipe: false,
      identity,
    } as unknown as ProjectableDossier;
    const p = projectSentinelDossier(dossier)!;
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.identity)).toBe(true);
    expect(() => {
      (p.identity.winningDigits as number[]).push(9);
    }).toThrow();
    // Source object untouched.
    expect(identity.winningDigits).toEqual([3, 4, 5]);
  });
});

describe("cross-confirmation is proposition-aware", () => {
  it("does NOT assume OVER = EVEN — it uses the winning-digit composition", () => {
    const result = crossConfirm(projection(), emptyEven, emptyOdd);
    expect(result.winningEvenCount).toBe(3);
    expect(result.winningOddCount).toBe(4);
    // OVER 2 leans ODD by composition, so it must never imply EVEN.
    expect(result.impliedParity).not.toBe("EVEN");
  });

  it("falls back to green-parity identity only on a balanced composition", () => {
    const balanced = projection({
      proposition: "OVER 1",
      identity: { winningDigits: [2, 3, 4, 5, 6, 7, 8, 9], losingDigits: [0, 1] },
    });
    const result = crossConfirm(balanced, emptyEven, emptyOdd);
    expect(result.parityTilt).toBe(0);
    expect(result.impliedParityBasis).toBe("GREEN_PARITY_IDENTITY");
    expect(result.impliedParity).toBe("ODD");
  });

  it("confirms when the parity cell matching the composition dominates", () => {
    const odd = maturedCell("ODD");
    const strongOdd = projection({
      identity: { winningDigits: [1, 3, 5, 7, 9], losingDigits: [0, 2, 4, 6, 8] },
    });
    const result = crossConfirm(strongOdd, emptyEven, odd);
    expect(result.impliedParity).toBe("ODD");
    expect(result.impliedParityBasis).toBe("WINNING_DIGIT_COMPOSITION");
    expect(result.verdict).toBe("CONFIRMS");
    expect(result.countsAsConfirmation).toBe(true);
  });

  it("contradicts when the opposing cell dominates", () => {
    const even = maturedCell("EVEN");
    const oddProposition = projection({
      identity: { winningDigits: [1, 3, 5, 7, 9], losingDigits: [0, 2, 4, 6, 8] },
    });
    const result = crossConfirm(oddProposition, even, emptyOdd);
    expect(result.verdict).toBe("CONTRADICTS");
    expect(result.countsAsConfirmation).toBe(false);
  });

  it("cannot confirm while a Sentinel hard veto is active", () => {
    const odd = maturedCell("ODD");
    const vetoed = projection({
      hardVetoActive: true,
      identity: { winningDigits: [1, 3, 5, 7, 9], losingDigits: [0, 2, 4, 6, 8] },
    });
    const result = crossConfirm(vetoed, emptyEven, odd);
    expect(result.verdict).toBe("CONFIRMS");
    expect(result.countsAsConfirmation).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/hard veto/i);
  });

  it("reports UNAVAILABLE before any parity observation exists", () => {
    expect(crossConfirm(projection(), emptyEven, emptyOdd).verdict).toBe("UNAVAILABLE");
  });
});

describe("cross-confirmation is read-only and deterministic", () => {
  it("returns identical results for identical inputs", () => {
    const even = maturedCell("EVEN");
    const odd = maturedCell("ODD");
    const a = crossConfirm(projection(), even, odd);
    const b = crossConfirm(projection(), even, odd);
    expect(a).toEqual(b);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it("does not mutate the Sentinel projection or the parity snapshots", () => {
    const p = Object.freeze(projection());
    const even = maturedCell("EVEN");
    const odd = maturedCell("ODD");
    const evenBefore = JSON.stringify(even);
    const oddBefore = JSON.stringify(odd);
    const pBefore = JSON.stringify(p);
    crossConfirm(p, even, odd);
    expect(JSON.stringify(p)).toBe(pBefore);
    expect(JSON.stringify(even)).toBe(evenBefore);
    expect(JSON.stringify(odd)).toBe(oddBefore);
  });

  it("orders many propositions deterministically", () => {
    const list = [projection({ cellId: "b" }), projection({ cellId: "a" })];
    const out = crossConfirmAll(list, emptyEven, emptyOdd);
    expect(out.map((c) => c.sentinelCellId)).toEqual(["a", "b"]);
    expect(crossConfirmAll(list, emptyEven, emptyOdd)).toEqual(out);
  });

  it("scores empty cells at zero support", () => {
    expect(cellSupportLevel(emptyEven)).toBe(0);
  });
});
