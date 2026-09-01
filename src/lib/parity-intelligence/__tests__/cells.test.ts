import { describe, expect, it } from "vitest";
import { ParityCell, cellIdFor, nextMaturity, scoreEvidence } from "../cells/cell";
import { ParityCellRegistry, fallbackSourceTickId, makeObservationIdentity } from "../cells/registry";
import { getEngineRole } from "../engine-registry";
import type {
  CanonicalParitySnapshot,
  CellObservation,
  HardVeto,
  ParityContextEvidence,
  ParityDirection,
  ParityEvidence,
  Parity,
  SoftBlocker,
} from "../types";

export function ctx(over: Partial<ParityContextEvidence> = {}): ParityContextEvidence {
  return {
    regime: "BALANCED",
    regimeStability: 70,
    hiddenRegime: "BALANCED",
    regimeCompatible: { EVEN: true, ODD: true },
    driftSeverity: "NONE",
    driftBreakDetected: false,
    statisticalStrength: "STRONG",
    significant: true,
    calibrationReliability: 0.8,
    dangerScore: 20,
    dangerCritical: false,
    evPoint: 0.03,
    evLow: 0.01,
    evClears: true,
    timing: "NOW",
    timingUrgency: "MEDIUM",
    entropy: 0.9,
    changepoint: false,
    multiHorizon: {
      short: "EVEN",
      medium: "EVEN",
      long: "EVEN",
      agreementScore: 90,
      alignment: "ALIGNED",
    },
    decorrelation: {
      rawVotes: 6,
      effectiveVotes: 4,
      inflationFactor: 1.5,
      confidencePenalty: 0.1,
    },
    feedQuality: 90,
    feedHardVeto: false,
    ...over,
  };
}

export function evidence(
  engine: string,
  direction: ParityDirection,
  strength = 0.8,
): ParityEvidence {
  const role = getEngineRole(engine);
  return {
    engine,
    family: role.family,
    authority: role.authority,
    correlationGroup: role.correlationGroup,
    direction,
    strength,
    confidence: 0.9,
    sampleAuthority: 0.9,
    detail: `${engine} -> ${direction}`,
  };
}

export function observation(
  parity: Parity,
  sequence: number,
  ev: readonly ParityEvidence[],
  over: {
    context?: ParityContextEvidence;
    hardVetoes?: readonly HardVeto[];
    softBlockers?: readonly SoftBlocker[];
    sourceTickId?: string;
  } = {},
): CellObservation {
  const sourceTickId = over.sourceTickId ?? `tick-${sequence}`;
  return {
    identity: {
      marketId: "R_100",
      parity,
      analysisVersion: sequence,
      sourceTickId,
      key: `R_100|${parity}|v${sequence}|${sourceTickId}`,
    },
    timestamp: 1_700_000_000_000 + sequence * 1000,
    sequence,
    evidence: ev,
    context: over.context ?? ctx(),
    hardVetoes: over.hardVetoes ?? [],
    softBlockers: over.softBlockers ?? [],
  };
}

const evenEvidence = [
  evidence("Distribution Engine", "EVEN"),
  evidence("Markov Engine", "EVEN"),
  evidence("Pressure Engine", "EVEN"),
];

describe("cell identity", () => {
  it("is permanent and derived from market + parity", () => {
    const cell = new ParityCell("R_100", "EVEN");
    expect(cell.cellId).toBe(cellIdFor("R_100", "EVEN"));
    expect(cell.cellId).toBe("R_100_EVEN");
    cell.ingest(observation("EVEN", 1, evenEvidence));
    expect(cell.snapshot().cellId).toBe("R_100_EVEN");
    expect(cell.snapshot().marketId).toBe("R_100");
    expect(cell.snapshot().parity).toBe("EVEN");
  });

  it("rejects an observation addressed to another identity", () => {
    const cell = new ParityCell("R_100", "EVEN");
    expect(cell.ingest(observation("ODD", 1, evenEvidence))).toBe("IDENTITY_MISMATCH");
    expect(cell.snapshot().observationCount).toBe(0);
  });

  it("cannot hydrate across identities", () => {
    const even = new ParityCell("R_100", "EVEN");
    const odd = new ParityCell("R_100", "ODD");
    expect(() => even.hydrate(odd.serialize())).toThrow(/identity is permanent/);
  });
});

describe("exactly-once observation", () => {
  it("ignores a duplicate observation key entirely", () => {
    const cell = new ParityCell("R_100", "EVEN");
    expect(cell.ingest(observation("EVEN", 1, evenEvidence))).toBe("ACCEPTED");
    const first = cell.snapshot();
    expect(cell.ingest(observation("EVEN", 1, evenEvidence))).toBe("DUPLICATE");
    const second = cell.snapshot();
    expect(second.observationCount).toBe(first.observationCount);
    expect(second.persistenceTicks).toBe(first.persistenceTicks);
    expect(second.maturity).toBe(first.maturity);
    expect(second.confidence).toBe(first.confidence);
    expect(second.history.length).toBe(first.history.length);
    expect(second.duplicateObservations).toBe(1);
  });

  it("ignores an out-of-order observation", () => {
    const cell = new ParityCell("R_100", "EVEN");
    cell.ingest(observation("EVEN", 5, evenEvidence));
    const before = cell.snapshot();
    expect(cell.ingest(observation("EVEN", 4, evenEvidence))).toBe("OUT_OF_ORDER");
    const after = cell.snapshot();
    expect(after.observationCount).toBe(before.observationCount);
    expect(after.outOfOrderObservations).toBe(1);
  });

  it("builds a deterministic fallback source identity", () => {
    const a = fallbackSourceTickId([1, 2, 3], 1000);
    const b = fallbackSourceTickId([1, 2, 3], 1000);
    expect(a).toBe(b);
    expect(a).not.toBe(fallbackSourceTickId([1, 2, 4], 1000));
  });

  it("derives observation identity from the canonical snapshot", () => {
    const snapshot = {
      symbol: "R_50",
      displayName: "Volatility 50",
      digits: [1, 2, 3],
      ticks: [],
      sourceTickId: "abc",
      analysisVersion: 7,
      timestamp: 1,
    } as unknown as CanonicalParitySnapshot;
    const id = makeObservationIdentity(snapshot, "ODD");
    expect(id.marketId).toBe("R_50");
    expect(id.parity).toBe("ODD");
    expect(id.analysisVersion).toBe(7);
    expect(id.key).toContain("abc");
  });
});

describe("both cells persist independently", () => {
  it("keeps the weaker hypothesis alive", () => {
    const registry = new ParityCellRegistry();
    for (let i = 1; i <= 6; i++) {
      registry.ingest(observation("EVEN", i, evenEvidence));
      registry.ingest(
        observation("ODD", i, evenEvidence), // same evidence: ODD sees it as opposing
      );
    }
    const even = registry.getCellSnapshot("R_100", "EVEN");
    const odd = registry.getCellSnapshot("R_100", "ODD");
    expect(even.observationCount).toBe(6);
    expect(odd.observationCount).toBe(6);
    expect(even.supportLevel).toBe("SUPPORTING");
    expect(odd.supportLevel).toBe("OPPOSING");
    expect(registry.getAllCells("R_100")).toHaveLength(2);
  });

  it("serializes and hydrates without losing state", () => {
    const registry = new ParityCellRegistry();
    for (let i = 1; i <= 4; i++) registry.ingest(observation("EVEN", i, evenEvidence));
    const payload = registry.serialize("R_100");
    const restored = new ParityCellRegistry();
    restored.hydrate(payload);
    expect(restored.getCellSnapshot("R_100", "EVEN").observationCount).toBe(4);
    restored.reset("R_100");
    expect(restored.getCellSnapshot("R_100", "EVEN").observationCount).toBe(0);
  });
});

describe("evidence scoring", () => {
  it("does not let correlated engines double-count", () => {
    const single = scoreEvidence("EVEN", [evidence("Distribution Engine", "EVEN")]);
    const groupA = getEngineRole("Distribution Engine").correlationGroup;
    const sibling = Object.values(
      { s: evidence("Stats Engine", "EVEN") },
    )[0];
    if (getEngineRole("Stats Engine").correlationGroup === groupA) {
      const doubled = scoreEvidence("EVEN", [evidence("Distribution Engine", "EVEN"), sibling]);
      // Two correlated observers must not exceed the single-observer support.
      expect(doubled.supportScore).toBeLessThanOrEqual(single.supportScore + 0.001);
    }
    expect(single.supportScore).toBeGreaterThan(0);
  });

  it("ignores META/GATE/CONTEXT engines as direction votes", () => {
    const direct = scoreEvidence("EVEN", evenEvidence);
    const withMeta = scoreEvidence("EVEN", [
      ...evenEvidence,
      evidence("Danger Engine", "ODD"),
      evidence("Timing Engine", "ODD"),
    ]);
    const nonDirect = ["Danger Engine", "Timing Engine"].filter(
      (e) => getEngineRole(e).authority !== "DIRECT",
    );
    if (nonDirect.length === 2) {
      expect(withMeta.supportScore).toBeCloseTo(direct.supportScore, 6);
    }
  });

  it("handles missing evidence safely", () => {
    const scored = scoreEvidence("EVEN", []);
    expect(scored.supportScore).toBe(0);
    expect(scored.net).toBe(0);
    expect(scored.meaningful).toBe(false);
  });
});

describe("contradictions", () => {
  it("keeps a hard contradiction visible instead of averaging it away", () => {
    const cell = new ParityCell("R_100", "EVEN");
    cell.ingest(
      observation("EVEN", 1, evenEvidence, {
        context: ctx({ dangerCritical: true, dangerScore: 95 }),
      }),
    );
    const snap = cell.snapshot();
    expect(snap.contradictions.some((c) => c.code === "DANGER_CONTRADICTION" && c.kind === "HARD")).toBe(
      true,
    );
    expect(snap.contradictionStreak).toBe(1);
  });

  it("records both supporting and opposing engines", () => {
    const cell = new ParityCell("R_100", "EVEN");
    cell.ingest(
      observation("EVEN", 1, [...evenEvidence, evidence("Pattern Engine", "ODD")]),
    );
    const snap = cell.snapshot();
    expect(snap.engineAgreement.length).toBeGreaterThan(0);
    expect(snap.engineDisagreement).toContain("Pattern Engine");
  });
});

describe("maturity", () => {
  it("cannot be created by one isolated strong tick", () => {
    const cell = new ParityCell("R_100", "EVEN");
    cell.ingest(observation("EVEN", 1, evenEvidence));
    expect(cell.snapshot().maturity).toBe("EMERGING");
  });

  it("develops through continuing evidence", () => {
    const cell = new ParityCell("R_100", "EVEN");
    for (let i = 1; i <= 8; i++) cell.ingest(observation("EVEN", i, evenEvidence));
    const snap = cell.snapshot();
    expect(snap.persistenceTicks).toBeGreaterThanOrEqual(6);
    expect(["BUILDING", "MATURE", "PEAK"]).toContain(snap.maturity);
  });

  it("weakens when evidence weakens and expires on a contradiction streak", () => {
    expect(
      nextMaturity("MATURE", {
        persistence: 6,
        confidence: 30,
        supportStreak: 0,
        contradictionStreak: 0,
        supported: false,
        hardContradiction: false,
      }),
    ).toBe("WEAKENING");
    expect(
      nextMaturity("MATURE", {
        persistence: 6,
        confidence: 90,
        supportStreak: 0,
        contradictionStreak: 5,
        supported: true,
        hardContradiction: true,
      }),
    ).toBe("EXPIRED");
  });
});
