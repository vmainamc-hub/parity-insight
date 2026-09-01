/**
 * SENTINEL <-> PARITY CROSS-CONFIRMATION (READ-ONLY, DETERMINISTIC)
 * ====================================================================
 * Inputs: an immutable Sentinel projection + immutable parity cell
 * snapshots. Output: a frozen `CrossConfirmationResult`. Same inputs always
 * produce the same output (§18). Nothing here mutates Sentinel or Parity.
 *
 * CRITICAL (§17): OVER is NOT assumed to be EVEN and UNDER is NOT assumed to
 * be ODD. Parity support is evaluated against the proposition's ACTUAL
 * winning-digit composition, falling back to the permanent green-parity
 * identity only when the composition is parity-balanced.
 */
import type {
  CrossConfirmationResult,
  CrossConfirmationVerdict,
  ParityCellSnapshot,
  ParityDirection,
  ReadonlySentinelProjection,
} from "../types";

const TILT_THRESHOLD = 0.2;
const CONFIRM_SUPPORT = 55;
const CONFIRM_MARGIN = 15;
const PARTIAL_SUPPORT = 40;

/** Cell-side support for cross-confirmation: evidence net + confidence only. */
export function cellSupportLevel(cell: ParityCellSnapshot): number {
  if (cell.observationCount === 0) return 0;
  const net = Math.max(0, cell.netEvidence) * 100;
  return clamp(cell.confidence * 0.5 + net * 0.5, 0, 100);
}

function trendOf(cell: ParityCellSnapshot): CrossConfirmationResult["trend"] {
  const h = cell.history;
  if (h.length < 3) return "UNKNOWN";
  const recent = h.slice(-3);
  const first = recent[0]!.confidence;
  const last = recent[recent.length - 1]!.confidence;
  const delta = last - first;
  if (delta > 4) return "STRENGTHENING";
  if (delta < -4) return "WEAKENING";
  return "STABLE";
}

export function crossConfirm(
  sentinel: ReadonlySentinelProjection,
  even: ParityCellSnapshot,
  odd: ParityCellSnapshot,
): CrossConfirmationResult {
  const reasons: string[] = [];
  const winning = sentinel.identity.winningDigits;
  const winningEvenCount = winning.filter((d) => d % 2 === 0).length;
  const winningOddCount = winning.filter((d) => d % 2 !== 0).length;
  const total = winningEvenCount + winningOddCount;
  const parityTilt = total > 0 ? (winningEvenCount - winningOddCount) / total : 0;

  let impliedParity: ParityDirection = "NEUTRAL";
  let impliedParityBasis: CrossConfirmationResult["impliedParityBasis"] = "NONE";

  if (Math.abs(parityTilt) >= TILT_THRESHOLD) {
    impliedParity = parityTilt > 0 ? "EVEN" : "ODD";
    impliedParityBasis = "WINNING_DIGIT_COMPOSITION";
    reasons.push(
      `${sentinel.proposition} winning digits [${winning.join(",")}] are ${winningEvenCount} even / ${winningOddCount} odd -> implies ${impliedParity}.`,
    );
  } else if (sentinel.identity.greenParity === sentinel.identity.secondGreenParity) {
    impliedParity = sentinel.identity.greenParity;
    impliedParityBasis = "GREEN_PARITY_IDENTITY";
    reasons.push(
      `Winning-digit composition is parity-balanced; permanent GREEN/2ND GREEN parity identity implies ${impliedParity}.`,
    );
  } else {
    reasons.push("Winning-digit composition is parity-balanced and green parities disagree.");
  }

  const evenCellSupport = cellSupportLevel(even);
  const oddCellSupport = cellSupportLevel(odd);
  const impliedCell = impliedParity === "EVEN" ? even : impliedParity === "ODD" ? odd : null;
  const opposingCell = impliedParity === "EVEN" ? odd : impliedParity === "ODD" ? even : null;

  let verdict: CrossConfirmationVerdict;
  if (even.observationCount === 0 && odd.observationCount === 0) {
    verdict = "UNAVAILABLE";
    reasons.push("No parity observation available yet.");
  } else if (!impliedCell || !opposingCell) {
    verdict = "NEUTRAL";
  } else {
    const forSupport = cellSupportLevel(impliedCell);
    const againstSupport = cellSupportLevel(opposingCell);
    if (forSupport >= CONFIRM_SUPPORT && forSupport >= againstSupport + CONFIRM_MARGIN) {
      verdict = "CONFIRMS";
      reasons.push(
        `Parity ${impliedCell.parity} cell supports the proposition's winning composition (${forSupport.toFixed(0)} vs ${againstSupport.toFixed(0)}).`,
      );
    } else if (againstSupport >= CONFIRM_SUPPORT && againstSupport >= forSupport + CONFIRM_MARGIN) {
      verdict = "CONTRADICTS";
      reasons.push(
        `Parity ${opposingCell.parity} cell dominates against the proposition's winning composition (${againstSupport.toFixed(0)} vs ${forSupport.toFixed(0)}).`,
      );
    } else if (forSupport >= PARTIAL_SUPPORT) {
      verdict = "PARTIAL";
      reasons.push(`Parity ${impliedCell.parity} support is present but not decisive.`);
    } else {
      verdict = "NEUTRAL";
      reasons.push("Parity evidence is neutral with respect to this proposition.");
    }
  }

  const trend = impliedCell ? trendOf(impliedCell) : "UNKNOWN";
  const regimeCompatible =
    sentinel.regimeCompatibility !== "INCOMPATIBLE" && (impliedCell?.regimeCompatible ?? false);

  const matureEnough =
    !!impliedCell && impliedCell.maturity !== "EMERGING" && impliedCell.maturity !== "EXPIRED";

  const countsAsConfirmation =
    verdict === "CONFIRMS" && regimeCompatible && matureEnough && !sentinel.hardVetoActive;

  if (!countsAsConfirmation && verdict === "CONFIRMS") {
    if (sentinel.hardVetoActive) reasons.push("Sentinel hard veto is active — cannot confirm.");
    if (!regimeCompatible) reasons.push("Regime is not compatible — cannot confirm.");
    if (!matureEnough) reasons.push("Parity cell is not mature enough to count as confirmation.");
  }

  return Object.freeze({
    proposition: sentinel.proposition,
    sentinelCellId: sentinel.cellId,
    impliedParity,
    impliedParityBasis,
    winningEvenCount,
    winningOddCount,
    parityTilt,
    evenCellSupport,
    oddCellSupport,
    verdict,
    trend,
    regimeCompatible,
    countsAsConfirmation,
    reasons: Object.freeze([...reasons]),
  });
}

/** Deterministic cross-confirmation over many propositions. Pure. */
export function crossConfirmAll(
  projections: readonly ReadonlySentinelProjection[],
  even: ParityCellSnapshot,
  odd: ParityCellSnapshot,
): readonly CrossConfirmationResult[] {
  return Object.freeze(
    [...projections]
      .sort((a, b) => a.cellId.localeCompare(b.cellId))
      .map((p) => crossConfirm(p, even, odd)),
  );
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}
