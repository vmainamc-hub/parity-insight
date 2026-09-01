/**
 * GOVERNANCE — HARD GATES, QUALIFICATION, ADMISSION
 * ====================================================================
 * Three questions are kept strictly separate (§37):
 *   Q1 what is developing?   -> ranking.ts
 *   Q2 is it valid?          -> qualification below
 *   Q3 is it admissible?     -> admission below
 *
 * AUTHORITY ORDER (§12): HARD GOVERNANCE -> weighted/calibrated evidence
 * -> confluence -> cell quality. A high weighted score can NEVER convert a
 * structurally invalid cell into a valid one.
 */
import type {
  AdmissionState,
  CrossConfirmationResult,
  EntryDigitReadiness,
  ParityCellSnapshot,
  QualificationState,
} from "../types";

export interface GateEvaluation {
  readonly qualification: QualificationState;
  readonly admission: AdmissionState;
  readonly reasoning: readonly string[];
  readonly blockingCodes: readonly string[];
}

export interface GateInputs {
  readonly cell: ParityCellSnapshot | null;
  readonly strength: number;
  readonly crossConfirmation: readonly CrossConfirmationResult[];
  readonly entryDigit: EntryDigitReadiness;
  /** Cross-confirmation is only REQUIRED when a Sentinel projection was supplied. */
  readonly requireCrossConfirmation: boolean;
}

const MIN_PERSISTENCE_FOR_QUALIFICATION = 3;
const MIN_CONFIDENCE_FOR_QUALIFICATION = 62;

export function evaluateGates(input: GateInputs): GateEvaluation {
  const reasoning: string[] = [];
  const blocking: string[] = [];
  const cell = input.cell;

  if (!cell || cell.observationCount === 0) {
    return freeze({
      qualification: "NO_VALID_SETUP",
      admission: "NOT_ADMITTED",
      reasoning: ["No parity cell has received an observation yet."],
      blockingCodes: ["NO_OBSERVATION"],
    });
  }

  // ── STAGE 1: hard governance. Evaluated first and never outweighed. ────
  for (const veto of cell.hardVetoes) {
    blocking.push(veto.code);
    reasoning.push(`HARD VETO ${veto.code} (${veto.engine}): ${veto.reason}`);
  }
  const hardContradictions = cell.contradictions.filter((c) => c.kind === "HARD");
  for (const c of hardContradictions) {
    blocking.push(c.code);
    reasoning.push(`HARD CONTRADICTION ${c.code}: ${c.detail}`);
  }
  if (!cell.regimeCompatible) {
    if (!blocking.includes("REGIME_INCOMPATIBLE")) blocking.push("REGIME_INCOMPATIBLE");
    reasoning.push(`Regime is incompatible with a ${cell.parity} thesis.`);
  }

  const sentinelVeto = input.crossConfirmation.filter((c) => c.verdict === "CONTRADICTS");
  for (const c of sentinelVeto) {
    blocking.push("SENTINEL_CONTRADICTION");
    reasoning.push(
      `Sentinel ${c.proposition}: winning-digit composition contradicts ${cell.parity}.`,
    );
  }

  // ── STAGE 2: developing vs candidate (evidence quality only) ───────────
  const developed =
    cell.persistenceTicks >= MIN_PERSISTENCE_FOR_QUALIFICATION &&
    cell.maturity !== "EMERGING" &&
    cell.maturity !== "EXPIRED";
  const strongEnough =
    cell.confidence >= MIN_CONFIDENCE_FOR_QUALIFICATION && cell.supportLevel === "SUPPORTING";

  if (blocking.length > 0) {
    // A blocked cell may still be the strongest developing candidate.
    reasoning.push(
      developed
        ? `Strongest developing ${cell.parity} cell is BLOCKED by hard governance.`
        : `${cell.parity} cell is immature and blocked.`,
    );
    return freeze({
      qualification: "BLOCKED",
      admission: "NOT_ADMITTED",
      reasoning,
      blockingCodes: dedupe(blocking),
    });
  }

  if (!developed) {
    reasoning.push(
      `${cell.parity} cell is still ${cell.maturity} (persistence ${cell.persistenceTicks}); a single strong tick is not maturity.`,
    );
    return freeze({
      qualification: cell.netEvidence > 0 ? "DEVELOPING" : "NO_VALID_SETUP",
      admission: "NOT_ADMITTED",
      reasoning,
      blockingCodes: ["IMMATURE"],
    });
  }

  if (!strongEnough) {
    reasoning.push(
      `${cell.parity} cell is developing but confidence ${cell.confidence.toFixed(0)} / support ${cell.supportLevel} is below the qualification bar.`,
    );
    return freeze({
      qualification: "CANDIDATE",
      admission: "NOT_ADMITTED",
      reasoning,
      blockingCodes: ["BELOW_QUALIFICATION_BAR"],
    });
  }

  // ── STAGE 3: admission. Qualified is still not admitted. ───────────────
  reasoning.push(
    `${cell.parity} cell QUALIFIED: ${cell.maturity}, persistence ${cell.persistenceTicks}, confidence ${cell.confidence.toFixed(0)}.`,
  );

  const admissionBlocks: string[] = [];
  if (input.requireCrossConfirmation) {
    const confirmed = input.crossConfirmation.some((c) => c.countsAsConfirmation);
    if (!confirmed) {
      admissionBlocks.push("NO_SENTINEL_CONFIRMATION");
      reasoning.push("Sentinel cross-confirmation was requested but did not reach confirmation.");
    }
  }
  if (!input.entryDigit.evaluated || input.entryDigit.entryDigit === null) {
    admissionBlocks.push("NO_ENTRY_DIGIT");
    reasoning.push(`Entry-digit validation incomplete: ${input.entryDigit.reason}`);
  }
  if (cell.softBlockers.length >= 4) {
    admissionBlocks.push("SOFT_BLOCKER_LOAD");
    reasoning.push(`${cell.softBlockers.length} soft blockers accumulated — quality is degraded.`);
  }

  if (admissionBlocks.length > 0) {
    return freeze({
      qualification: "QUALIFIED",
      admission: "NOT_ADMITTED",
      reasoning,
      blockingCodes: dedupe(admissionBlocks),
    });
  }

  reasoning.push(`${cell.parity} cell ADMITTED for downstream arbitration.`);
  return freeze({
    qualification: "QUALIFIED",
    admission: "ADMITTED",
    reasoning,
    blockingCodes: [],
  });
}

function dedupe(list: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(list)]);
}

function freeze(e: {
  qualification: QualificationState;
  admission: AdmissionState;
  reasoning: readonly string[];
  blockingCodes: readonly string[];
}): GateEvaluation {
  return Object.freeze({
    qualification: e.qualification,
    admission: e.admission,
    reasoning: Object.freeze([...e.reasoning]),
    blockingCodes: Object.freeze([...e.blockingCodes]),
  });
}
