/**
 * ENTRY-DIGIT ADAPTER — STRICTLY DOWNSTREAM (§24)
 * ====================================================================
 * The existing `computeSpecificParityEntryDigit` engine remains the source of
 * truth for transition occurrences, Laplace smoothing, Wilson lower bound,
 * edge, stability, expected wait, recent momentum, sample authority and the
 * composite score. Nothing is re-implemented here.
 *
 * A good entry digit can NEVER make an invalid parity cell valid: this adapter
 * refuses to run until the cell has established a legitimate direction.
 */
import { computeSpecificParityEntryDigit } from "@/lib/precision-parity/engines/specific-entry-digit";
import type { CanonicalParitySnapshot, EntryDigitReadiness, ParityCellSnapshot } from "../types";

const NOT_EVALUATED = (reason: string): EntryDigitReadiness =>
  Object.freeze({
    evaluated: false,
    reason,
    targetContract: null,
    entryDigit: null,
    confidence: 0,
    status: null,
  });

export interface EntryDigitInputs {
  readonly snapshot: CanonicalParitySnapshot;
  readonly cell: ParityCellSnapshot | null;
  /** True only when the cell has cleared hard governance upstream. */
  readonly cellDirectionEstablished: boolean;
}

export function evaluateEntryDigit(input: EntryDigitInputs): EntryDigitReadiness {
  const cell = input.cell;
  if (!cell || cell.observationCount === 0) {
    return NOT_EVALUATED("No parity cell direction established yet.");
  }
  if (!input.cellDirectionEstablished) {
    return NOT_EVALUATED(
      `Entry digit is downstream: ${cell.parity} cell has not established a legitimate direction.`,
    );
  }
  if (input.snapshot.digits.length < 60) {
    return NOT_EVALUATED("Insufficient digit history for entry-digit statistics.");
  }

  const targetContract = cell.parity === "EVEN" ? "DIGITEVEN" : "DIGITODD";
  const decision = computeSpecificParityEntryDigit(
    [...input.snapshot.digits],
    targetContract,
    input.snapshot.symbol,
    input.snapshot.displayName,
  );

  return Object.freeze({
    evaluated: true,
    reason: decision.instructionHeadline,
    targetContract,
    entryDigit: decision.entryDigit,
    confidence: decision.confidence,
    status: decision.status,
    raw: decision,
  });
}
