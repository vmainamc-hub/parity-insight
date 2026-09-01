/**
 * ENGINE RUNNER + ADAPTERS
 * ====================================================================
 * Runs the EXISTING Precision Parity engines and maps their output onto
 * the normalized `ParityEvidence` model. No engine mathematics is
 * re-implemented here (§9); every number below comes out of an existing
 * engine module.
 *
 * MEMORY ISOLATION: several existing engines keep per-market memory
 * (structural, hmm, drift, decorrelation, ...). To guarantee the live
 * pipeline's behaviour is unchanged (§30) this subsystem addresses those
 * engines under a namespaced market key.
 */
import type { Tick } from "@/lib/analytics";
import type { Evidence, ParityContract } from "@/lib/precision-parity/types";

import { runParityStatsEngine } from "@/lib/precision-parity/engines/stats-engine";
import { runParityMarkovEngine } from "@/lib/precision-parity/engines/markov-engine";
import { runParityRunEngine } from "@/lib/precision-parity/engines/run-hazard-engine";
import { runParityPressureEngine } from "@/lib/precision-parity/engines/pressure-engine";
import { runParityPatternEngine } from "@/lib/precision-parity/engines/pattern-engine";
import { runParityEntropyEngine } from "@/lib/precision-parity/engines/entropy-engine";
import { runParityAnomalyEngine } from "@/lib/precision-parity/engines/anomaly-engine";
import { runMarketQualityEngine } from "@/lib/precision-parity/engines/market-quality-engine";
import { runMultiHorizonEngine } from "@/lib/precision-parity/engines/multi-horizon-engine";
import { runParityChangepointEngine } from "@/lib/precision-parity/engines/changepoint-engine";
import { runParityDangerEngine } from "@/lib/precision-parity/engines/danger-engine";
import { runParityRegimeEngine } from "@/lib/precision-parity/engines/regime-engine";
import { runParityConfluenceEngine } from "@/lib/precision-parity/engines/confluence-engine";
import { runParityTimingEngine } from "@/lib/precision-parity/engines/timing-engine";
import { runEVGateEngine } from "@/lib/precision-parity/engines/ev-gate-engine";
import { fitParityHMM } from "@/lib/precision-parity/hmm";
import { runParticleFilter } from "@/lib/precision-parity/particle-filter";
import { runDriftDetection } from "@/lib/precision-parity/drift";
import { computeSignificance } from "@/lib/precision-parity/significance";
import { analyseStructural } from "@/lib/precision-parity/structural";
import { decorrelate } from "@/lib/precision-parity/decorrelation";

import { getEngineRole } from "../engine-registry";
import type {
  CanonicalParitySnapshot,
  HardVeto,
  ParityContextEvidence,
  ParityDirection,
  ParityEvidence,
  SoftBlocker,
} from "../types";

/** Namespace suffix keeping engine memory separate from the live pipeline. */
export const INTELLIGENCE_MEMORY_NAMESPACE = "::parity-intelligence";

export function intelligenceMarketKey(symbol: string): string {
  return `${symbol}${INTELLIGENCE_MEMORY_NAMESPACE}`;
}

export interface EngineRunOutput {
  readonly evidence: readonly ParityEvidence[];
  readonly context: ParityContextEvidence;
  readonly hardVetoes: readonly HardVeto[];
  readonly softBlockers: readonly SoftBlocker[];
  readonly diagnostics: Readonly<Record<string, unknown>>;
}

function ev(
  engine: string,
  direction: ParityDirection,
  strength: number,
  confidence: number,
  sampleAuthority: number,
  detail: string,
  metrics?: Record<string, number>,
  raw?: unknown,
): ParityEvidence {
  const r = getEngineRole(engine);
  return Object.freeze({
    engine,
    family: r.family,
    authority: r.authority,
    correlationGroup: r.correlationGroup,
    direction,
    strength: clamp01(strength),
    confidence: clamp01(confidence),
    sampleAuthority: clamp01(sampleAuthority),
    detail,
    metrics: metrics ? Object.freeze({ ...metrics }) : undefined,
    raw,
  });
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function side(s: "EVEN" | "ODD" | "NEUTRAL" | "NO_TRADE"): ParityDirection {
  return s === "EVEN" || s === "ODD" ? s : "NEUTRAL";
}

function sampleAuthority(n: number, target = 500): number {
  return clamp01(n / target);
}

/** Existing `Evidence` (structural.ts) -> normalized parity evidence. */
export function adaptLegacyEvidence(engine: string, e: Evidence): ParityEvidence {
  const dir: ParityDirection =
    e.supports === "BUY_EVEN" ? "EVEN" : e.supports === "BUY_ODD" ? "ODD" : "NEUTRAL";
  return ev(engine, dir, e.strength, e.strength, 0.5, `${e.engine}: ${e.detail}`, undefined, e);
}

function toLegacyEvidence(list: readonly ParityEvidence[]): Evidence[] {
  return list.map((p) => ({
    engine: p.engine,
    supports: (p.direction === "EVEN"
      ? "BUY_EVEN"
      : p.direction === "ODD"
        ? "BUY_ODD"
        : "NEUTRAL") as ParityContract | "NEUTRAL",
    strength: p.strength,
    detail: p.detail,
  }));
}

/**
 * Run all existing engines against a canonical snapshot and normalize.
 * Pure with respect to the live pipeline: only namespaced engine memory
 * is touched.
 */
export function runEngines(snapshot: CanonicalParitySnapshot): EngineRunOutput {
  const digits = [...snapshot.digits];
  const ticks = [...snapshot.ticks] as Tick[];
  const marketKey = intelligenceMarketKey(snapshot.symbol);
  const payout = snapshot.payoutRate ?? 0.95;

  const stats = runParityStatsEngine(digits);
  const markov = runParityMarkovEngine(digits);
  const runs = runParityRunEngine(digits);
  const pressure = runParityPressureEngine(digits);
  const pattern = runParityPatternEngine(digits);
  const entropy = runParityEntropyEngine(digits);
  const anomaly = runParityAnomalyEngine(digits);
  const quality = runMarketQualityEngine(ticks);
  const multiHorizon = runMultiHorizonEngine(stats);
  const changepoint = runParityChangepointEngine(digits);
  const regime = runParityRegimeEngine(digits);
  const hmm = fitParityHMM(digits, marketKey);
  const structural = analyseStructural(marketKey, digits);
  const confluence = runParityConfluenceEngine(
    stats,
    markov,
    runs,
    pressure,
    pattern,
    regime,
    anomaly,
    changepoint.discountFactor,
  );

  const dominant = confluence.favouredSide === "NO_TRADE" ? stats.dominantSide : confluence.favouredSide;
  const targetSide: "EVEN" | "ODD" = dominant === "ODD" ? "ODD" : "EVEN";
  const targetContract = targetSide === "EVEN" ? "BUY_EVEN" : "BUY_ODD";

  const particles = runParticleFilter(digits, targetContract);
  const drift = runDriftDetection(digits, marketKey, targetContract);
  const significance = computeSignificance(digits, targetContract, payout);
  const danger = runParityDangerEngine(
    targetSide,
    digits.length,
    runs,
    changepoint,
    entropy,
    quality,
    multiHorizon,
  );
  const timing = runParityTimingEngine(targetSide, runs, pressure, confluence.agreementRatio >= 0.6);
  const evGate = runEVGateEngine(stats.lowerBoundPWin, stats.pointEstimatePWin, payout);

  // ── Normalized evidence ────────────────────────────────────────────────
  const evidence: ParityEvidence[] = [];

  const primary = stats.windows[stats.primaryWindow];
  evidence.push(
    ev(
      "stats",
      side(stats.dominantSide),
      Math.min(1, Math.abs(stats.pointEstimatePWin - 0.5) * 8),
      stats.overallConfidence / 100,
      sampleAuthority(primary?.sampleSize ?? digits.length),
      stats.summary,
      {
        pointEstimatePWin: stats.pointEstimatePWin,
        lowerBoundPWin: stats.lowerBoundPWin,
        primaryWindow: stats.primaryWindow,
      },
      stats,
    ),
  );

  evidence.push(
    ev(
      "multiHorizon",
      side(multiHorizon.consensusSide),
      multiHorizon.agreementScore / 100,
      multiHorizon.agreementScore / 100,
      sampleAuthority(digits.length),
      multiHorizon.summary,
      { agreementScore: multiHorizon.agreementScore, penalty: multiHorizon.horizonDivergencePenalty },
      multiHorizon,
    ),
  );

  evidence.push(
    ev(
      "markov",
      side(markov.favouredSide),
      Math.min(1, Math.abs(markov.pointEstimatePWin - 0.5) * 8),
      Math.max(0, (markov.lowerBoundPWin - 0.5) * 8),
      sampleAuthority(markov.sampleSize, 300),
      markov.summary,
      { pointEstimatePWin: markov.pointEstimatePWin, lowerBoundPWin: markov.lowerBoundPWin },
      markov,
    ),
  );

  evidence.push(
    ev(
      "pattern",
      side(pattern.favouredSide),
      Math.min(1, Math.abs(pattern.pointEstimatePWin - 0.5) * 8),
      Math.max(0, (pattern.lowerBoundPWin - 0.5) * 8),
      sampleAuthority(pattern.sampleSize, 120),
      pattern.summary,
      { pointEstimatePWin: pattern.pointEstimatePWin, sampleSize: pattern.sampleSize },
      pattern,
    ),
  );

  // Run/hazard: RIDE_RUN supports the active side, FADE_RUN opposes it.
  const runDirection: ParityDirection =
    runs.suggestedAction === "RIDE_RUN"
      ? runs.activeSide
      : runs.suggestedAction === "FADE_RUN"
        ? runs.activeSide === "EVEN"
          ? "ODD"
          : "EVEN"
        : "NEUTRAL";
  evidence.push(
    ev(
      "runs",
      runDirection,
      runDirection === "NEUTRAL" ? 0 : Math.abs(runs.pContinueNextTick - 0.5) * 2,
      runs.sampleSizeAtThisLength > 0 ? 0.6 : 0.2,
      sampleAuthority(runs.totalRunsObserved, 120),
      runs.summary,
      { pBreakNextTick: runs.pBreakNextTick, activeLength: runs.activeLength },
      runs,
    ),
  );

  // Pressure: the engine reports both readings; stretch decides which leads.
  const pressureDirection: ParityDirection =
    pressure.stretchedState === "EXTREME_STRETCH"
      ? side(pressure.favouredMeanReversion)
      : side(pressure.favouredMomentum);
  evidence.push(
    ev(
      "pressure",
      pressureDirection,
      Math.min(1, Math.abs(pressure.zScore) / 3),
      (pressure.stretchedState === "EXTREME_STRETCH"
        ? pressure.reversionConfidence
        : pressure.momentumConfidence) / 100,
      sampleAuthority(digits.length, 100),
      pressure.summary,
      { zScore: pressure.zScore, imbalance: pressure.cumulativeImbalance },
      pressure,
    ),
  );

  evidence.push(
    ev(
      "anomaly",
      anomaly.anomalyDirection === "SURGE_EVEN"
        ? "EVEN"
        : anomaly.anomalyDirection === "SURGE_ODD"
          ? "ODD"
          : "NEUTRAL",
      anomaly.isAnomaly ? Math.min(1, Math.abs(anomaly.zScore) / 3) : 0,
      anomaly.significanceLevel === "p < 0.01" ? 0.9 : anomaly.significanceLevel === "p < 0.05" ? 0.6 : 0.2,
      sampleAuthority(digits.length, 300),
      anomaly.summary,
      { zScore: anomaly.zScore },
      anomaly,
    ),
  );

  for (const legacy of structural.evidence) {
    evidence.push(adaptLegacyEvidence("structural", legacy));
  }

  const hmmEvenBias =
    hmm.currentState === "EVEN_DOMINANCE" ? 1 : hmm.currentState === "ODD_DOMINANCE" ? -1 : 0;
  evidence.push(
    ev(
      "hmm",
      hmmEvenBias > 0 ? "EVEN" : hmmEvenBias < 0 ? "ODD" : "NEUTRAL",
      Math.abs(hmmEvenBias) * clamp01(hmm.stateProbabilities[hmm.currentState] ?? 0),
      clamp01(hmm.stateProbabilities[hmm.currentState] ?? 0),
      sampleAuthority(digits.length),
      hmm.narrative,
      { expectedDwellTicks: hmm.expectedDwellTicks },
      hmm,
    ),
  );

  evidence.push(
    ev(
      "regime",
      regime.regime === "EVEN_BIASED" ? "EVEN" : regime.regime === "ODD_BIASED" ? "ODD" : "NEUTRAL",
      clamp01(regime.biasScore / 10),
      regime.regimeStability / 100,
      sampleAuthority(digits.length),
      regime.summary,
      { regimeStability: regime.regimeStability, alternatingRatio: regime.alternatingRatio },
      regime,
    ),
  );

  evidence.push(
    ev(
      "particles",
      particles.posteriorMeanEven > 0.5 ? "EVEN" : particles.posteriorMeanEven < 0.5 ? "ODD" : "NEUTRAL",
      Math.min(1, Math.abs(particles.posteriorMeanEven - 0.5) * 8),
      particles.weightCollapse ? 0 : clamp01(particles.effectiveParticles / 100),
      sampleAuthority(digits.length),
      particles.narrative,
      { posteriorMeanEven: particles.posteriorMeanEven, effectiveParticles: particles.effectiveParticles },
      particles,
    ),
  );

  evidence.push(
    ev(
      "significance",
      significance.significant ? side(targetSide) : "NEUTRAL",
      significance.significant ? clamp01(1 - significance.pValue) : 0,
      clamp01(1 - significance.qValue),
      sampleAuthority(digits.length),
      significance.narrative,
      { pValue: significance.pValue, qValue: significance.qValue },
      significance,
    ),
  );

  evidence.push(
    ev(
      "confluence",
      side(confluence.favouredSide),
      clamp01(Math.abs(confluence.compositeScore - 50) / 50),
      confluence.rawConfidence / 100,
      confluence.agreementRatio,
      confluence.summary,
      { compositeScore: confluence.compositeScore, agreementRatio: confluence.agreementRatio },
      confluence,
    ),
  );

  const decorrelation = decorrelate(toLegacyEvidence(evidence), marketKey);

  // ── Hard vetoes (§11) — derived from existing governance semantics ─────
  const hardVetoes: HardVeto[] = [];
  const softBlockers: SoftBlocker[] = [];

  if (digits.length < 60) {
    hardVetoes.push(
      Object.freeze({
        code: "INSUFFICIENT_DATA",
        engine: "stats",
        reason: `Only ${digits.length} digits available; minimum sample not met.`,
        parity: null,
      }),
    );
  }
  if (quality.isHardVeto) {
    hardVetoes.push(
      Object.freeze({
        code: "FEED_QUALITY",
        engine: "quality",
        reason: quality.vetoReason ?? quality.summary,
        parity: null,
      }),
    );
  }
  if (entropy.isHighEntropyVeto) {
    hardVetoes.push(
      Object.freeze({
        code: "HIGH_ENTROPY",
        engine: "entropy",
        reason: entropy.summary,
        parity: null,
      }),
    );
  }
  if (danger.hasCriticalVeto) {
    for (const reason of danger.vetoReasons) {
      hardVetoes.push(
        Object.freeze({ code: "CRITICAL_DANGER", engine: "danger", reason, parity: targetSide }),
      );
    }
  }
  if (drift.breakDetected && drift.severity === "MAJOR") {
    hardVetoes.push(
      Object.freeze({
        code: "MAJOR_DRIFT",
        engine: "drift",
        reason: drift.narrative,
        parity: null,
      }),
    );
  }
  if (particles.weightCollapse) {
    hardVetoes.push(
      Object.freeze({
        code: "POSTERIOR_COLLAPSE",
        engine: "particles",
        reason: particles.narrative,
        parity: null,
      }),
    );
  }
  if (!evGate.clearsGate) {
    hardVetoes.push(
      Object.freeze({
        code: "EV_GATE",
        engine: "evGate",
        reason: evGate.vetoReason ?? evGate.summary,
        parity: targetSide,
      }),
    );
  }

  // ── Soft blockers ──────────────────────────────────────────────────────
  if (drift.breakDetected && drift.severity === "MINOR") {
    softBlockers.push(
      Object.freeze({ code: "MINOR_DRIFT", engine: "drift", reason: drift.narrative, penalty: 0.15, parity: null }),
    );
  }
  if (changepoint.state !== "STABLE") {
    softBlockers.push(
      Object.freeze({
        code: "CHANGEPOINT",
        engine: "changepoint",
        reason: changepoint.summary,
        penalty: clamp01(1 - changepoint.discountFactor),
        parity: null,
      }),
    );
  }
  if (multiHorizon.horizonDivergencePenalty > 0) {
    softBlockers.push(
      Object.freeze({
        code: "HORIZON_DIVERGENCE",
        engine: "multiHorizon",
        reason: multiHorizon.summary,
        penalty: clamp01(multiHorizon.horizonDivergencePenalty / 100),
        parity: null,
      }),
    );
  }
  if (decorrelation.confidencePenalty > 0) {
    softBlockers.push(
      Object.freeze({
        code: "CORRELATED_EVIDENCE",
        engine: "decorrelation",
        reason: decorrelation.narrative,
        penalty: clamp01(decorrelation.confidencePenalty / 100),
        parity: null,
      }),
    );
  }
  if (danger.dangerScore >= 40 && !danger.hasCriticalVeto) {
    softBlockers.push(
      Object.freeze({
        code: "ELEVATED_DANGER",
        engine: "danger",
        reason: danger.summary,
        penalty: clamp01(danger.dangerScore / 200),
        parity: targetSide,
      }),
    );
  }
  if (timing.timing !== "NOW" && timing.timing !== "NEXT_TICK") {
    softBlockers.push(
      Object.freeze({
        code: "TIMING_NOT_READY",
        engine: "timing",
        reason: timing.condition,
        penalty: 0.1,
        parity: null,
      }),
    );
  }

  // ── Regime compatibility per parity ────────────────────────────────────
  const regimeCompatible = {
    EVEN: isRegimeCompatible("EVEN", regime.regime, hmm.currentState),
    ODD: isRegimeCompatible("ODD", regime.regime, hmm.currentState),
  } as const;

  const alignment =
    multiHorizon.agreementScore >= 95
      ? "ALIGNED"
      : multiHorizon.agreementScore >= 60
        ? "PARTIAL"
        : multiHorizon.isAligned
          ? "PARTIAL"
          : contradictoryHorizons(multiHorizon.shortHorizonSide, multiHorizon.longHorizonSide)
            ? "CONTRADICTORY"
            : "MIXED";

  const context: ParityContextEvidence = Object.freeze({
    regime: regime.regime,
    regimeStability: regime.regimeStability,
    hiddenRegime: hmm.currentState,
    regimeCompatible,
    driftSeverity: drift.severity,
    driftBreakDetected: drift.breakDetected,
    statisticalStrength:
      digits.length < 60
        ? "INSUFFICIENT"
        : significance.significant && stats.overallConfidence >= 65
          ? "STRONG"
          : stats.overallConfidence >= 55
            ? "MODERATE"
            : "WEAK",
    significant: significance.significant,
    calibrationReliability: clamp01(1 - Math.abs(0.5 - stats.pointEstimatePWin) * 0.2),
    dangerScore: danger.dangerScore,
    dangerCritical: danger.hasCriticalVeto,
    evPoint: evGate.pointEstimateEV,
    evLow: evGate.lowerBoundEV,
    evClears: evGate.clearsGate,
    timing: timing.timing,
    timingUrgency: timing.urgency,
    entropy: entropy.aggregateEntropy,
    changepoint: changepoint.hasChangepoint,
    multiHorizon: Object.freeze({
      short: side(multiHorizon.shortHorizonSide),
      medium: side(multiHorizon.mediumHorizonSide),
      long: side(multiHorizon.longHorizonSide),
      agreementScore: multiHorizon.agreementScore,
      alignment,
    }),
    decorrelation: Object.freeze({
      rawVotes: decorrelation.rawVotes,
      effectiveVotes: decorrelation.effectiveVotes,
      inflationFactor: decorrelation.inflationFactor,
      confidencePenalty: decorrelation.confidencePenalty,
    }),
    feedQuality: quality.qualityScore,
    feedHardVeto: quality.isHardVeto,
  });

  return Object.freeze({
    evidence: Object.freeze(evidence),
    context,
    hardVetoes: Object.freeze(hardVetoes),
    softBlockers: Object.freeze(softBlockers),
    diagnostics: Object.freeze({
      stats,
      markov,
      runs,
      pressure,
      pattern,
      entropy,
      anomaly,
      quality,
      multiHorizon,
      changepoint,
      regime,
      hmm,
      structural,
      confluence,
      particles,
      drift,
      significance,
      danger,
      timing,
      evGate,
      decorrelation,
    }),
  });
}

function contradictoryHorizons(short: string, long: string): boolean {
  return (short === "EVEN" && long === "ODD") || (short === "ODD" && long === "EVEN");
}

/**
 * A parity proposition is regime-incompatible when the stream regime or the
 * hidden regime is actively dominated by the opposite parity, or when the
 * stream is alternating hard enough that a directional parity thesis has no
 * carrier. Derived from the existing regime/HMM vocabulary.
 */
export function isRegimeCompatible(
  parity: "EVEN" | "ODD",
  streamRegime: string,
  hiddenRegime: string,
): boolean {
  const opposite = parity === "EVEN" ? "ODD" : "EVEN";
  if (streamRegime === `${opposite}_BIASED`) return false;
  if (hiddenRegime === `${opposite}_DOMINANCE`) return false;
  if (hiddenRegime === "REVERSAL_BUILDING" && streamRegime === `${parity}_BIASED`) return false;
  return true;
}
