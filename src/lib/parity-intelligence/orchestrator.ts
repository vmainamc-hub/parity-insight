/**
 * PURE ORCHESTRATOR — analyzeParityIntelligence (§27)
 * ====================================================================
 * CANONICAL SNAPSHOT -> existing engines -> normalized evidence -> EVEN +
 * ODD cells -> persistent state -> support/conflict/contradiction ->
 * maturity/persistence/regime/drift -> Sentinel read-only cross-confirmation
 * -> structural + statistical admission -> entry-digit validation -> DBot
 * replay -> immutable ParityIntelligenceSnapshot.
 *
 * This function does NOT touch React state, UI, navigation, WebSockets, the
 * live signal pipeline or Sentinel. It is a pure-ish function of its inputs
 * plus the cell registry it is explicitly handed.
 */
import { ParityCellRegistry, makeObservationIdentity } from "./cells/registry";
import { runEngines } from "./evidence/engine-runner";
import { evaluateGates } from "./governance/gates";
import { cellStrength, rankCells, strongestCell } from "./governance/ranking";
import { crossConfirmAll } from "./sentinel/bridge";
import { evaluateEntryDigit } from "./entry/entry-digit";
import { localReplayValidator } from "./dbot/replay-validator";
import type {
  CanonicalParitySnapshot,
  ContradictionRecord,
  EntryDigitReplayValidator,
  ParityCellSnapshot,
  ParityIntelligenceSnapshot,
  ReadonlySentinelProjection,
  ReplayValidationResult,
} from "./types";

export interface AnalyzeOptions {
  /** Cell registry owning persistent state. One is created per call if omitted. */
  readonly registry?: ParityCellRegistry;
  /** Read-only Sentinel projections. Never mutated, never ingested. */
  readonly sentinel?: readonly ReadonlySentinelProjection[];
  /** Replay validator. Defaults to the deterministic local parity replay. */
  readonly replayValidator?: EntryDigitReplayValidator | null;
}

export function analyzeParityIntelligence(
  snapshot: CanonicalParitySnapshot,
  options: AnalyzeOptions = {},
): ParityIntelligenceSnapshot {
  const registry = options.registry ?? new ParityCellRegistry();
  const projections = options.sentinel ?? [];
  const validator =
    options.replayValidator === undefined ? localReplayValidator : options.replayValidator;

  // 1. Existing engines run unchanged; only their output is normalized.
  const run = runEngines(snapshot);

  // 2. BOTH cells receive the observation. The weaker one is never discarded.
  for (const parity of ["EVEN", "ODD"] as const) {
    registry.ingest({
      identity: makeObservationIdentity(snapshot, parity),
      timestamp: snapshot.timestamp,
      sequence: snapshot.analysisVersion,
      evidence: run.evidence,
      context: run.context,
      hardVetoes: run.hardVetoes,
      softBlockers: run.softBlockers,
    });
  }

  const even = registry.getCellSnapshot(snapshot.symbol, "EVEN");
  const odd = registry.getCellSnapshot(snapshot.symbol, "ODD");

  // 3. Ranking answers "what is developing?" only. It never ingests.
  const ranking = rankCells(even, odd);
  const strongest = strongestCell(ranking);
  const candidate: ParityCellSnapshot | null =
    strongest === "EVEN" ? even : strongest === "ODD" ? odd : null;

  // 4. Sentinel cross-confirmation — read-only and deterministic.
  const crossConfirmation = crossConfirmAll(projections, even, odd);

  // 5. Structural/statistical admission. Entry digit is strictly downstream:
  //    a provisional gate pass decides whether it may even be computed.
  const provisional = evaluateGates({
    cell: candidate,
    strength: candidate ? cellStrength(candidate) : 0,
    crossConfirmation,
    entryDigit: evaluateEntryDigit({ snapshot, cell: candidate, cellDirectionEstablished: false }),
    requireCrossConfirmation: projections.length > 0,
  });

  const directionEstablished =
    provisional.qualification === "QUALIFIED" &&
    !provisional.blockingCodes.some((c) => c !== "NO_ENTRY_DIGIT" && c !== "SOFT_BLOCKER_LOAD");

  const entryDigit = evaluateEntryDigit({
    snapshot,
    cell: candidate,
    cellDirectionEstablished: directionEstablished,
  });

  const gates = directionEstablished
    ? evaluateGates({
        cell: candidate,
        strength: candidate ? cellStrength(candidate) : 0,
        crossConfirmation,
        entryDigit,
        requireCrossConfirmation: projections.length > 0,
      })
    : provisional;

  // 6. DBot replay validation of the candidate entry digit.
  let dbot: ReplayValidationResult | null = null;
  if (validator && entryDigit.evaluated && entryDigit.entryDigit !== null && candidate) {
    dbot = validator.validate({
      digits: snapshot.digits,
      entryDigit: entryDigit.entryDigit,
      targetParity: candidate.parity,
    });
  }

  const reasoning = [
    strongest
      ? `Strongest developing cell: ${strongest} (strength ${ranking[0]!.strength.toFixed(0)}).`
      : "Neither parity cell shows developing evidence — NO VALID PARITY SETUP.",
    ...gates.reasoning,
    ...(dbot ? [`DBot replay: ${dbot.reason}`] : []),
  ];

  const admission =
    gates.admission === "ADMITTED" && (dbot === null || dbot.validated)
      ? "ADMITTED"
      : "NOT_ADMITTED";
  if (gates.admission === "ADMITTED" && admission === "NOT_ADMITTED") {
    reasoning.push("Admission withheld: DBot replay validation did not pass.");
  }

  const contradictions: readonly ContradictionRecord[] = Object.freeze([
    ...even.contradictions,
    ...odd.contradictions,
  ]);

  return Object.freeze({
    timestamp: snapshot.timestamp,
    market: Object.freeze({ symbol: snapshot.symbol, displayName: snapshot.displayName }),
    source: Object.freeze({
      sourceTickId: snapshot.sourceTickId,
      analysisVersion: snapshot.analysisVersion,
      digitCount: snapshot.digits.length,
    }),
    even,
    odd,
    strongestCell: strongest,
    ranking,
    evidence: run.evidence,
    context: run.context,
    contradictions,
    crossConfirmation,
    entryDigit,
    dbot,
    hardVetoes: candidate ? candidate.hardVetoes : run.hardVetoes,
    softBlockers: candidate ? candidate.softBlockers : run.softBlockers,
    qualification: gates.qualification,
    admission,
    reasoning: Object.freeze(reasoning),
  });
}
