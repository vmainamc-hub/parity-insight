/**
 * Shared deterministic fixtures for the parity-intelligence test suite.
 * Not a *.test.ts file, so vitest does not collect it as a suite.
 */
import { getEngineRole } from "../engine-registry";
import type {
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


export const evenEvidence: readonly ParityEvidence[] = [
  evidence("stats", "EVEN"),
  evidence("markov", "EVEN"),
  evidence("pressure", "EVEN"),
];
