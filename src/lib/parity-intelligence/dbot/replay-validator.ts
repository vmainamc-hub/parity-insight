/**
 * DBOT REPLAY VALIDATION INTERFACE (§25)
 * ====================================================================
 * The repository's existing DBot replay lives in
 * `src/lib/precision-edge/bot/simulator.ts` and encodes the OVER/UNDER bot
 * ladder — it is NOT a parity (DIGITEVEN/DIGITODD) replay, so it is not
 * reused here and nothing about it is faked. Instead this module provides the
 * clean, deterministic `EntryDigitReplayValidator` contract that a real
 * parity DBot replay is wired into later.
 *
 * CADENCE (non-negotiable): OPEN -> SETTLE -> OPEN -> SETTLE ...
 * A contract opened on tick i settles on tick i+1, and that settlement tick is
 * consumed: the next trade may only open from tick i+2 onwards. A settlement
 * tick is never reused as the next trade's opening tick.
 */
import type {
  EntryDigitReplayValidator,
  ReplayTrade,
  ReplayValidationRequest,
  ReplayValidationResult,
} from "../types";

const MIN_TRADES = 12;
const MIN_WIN_RATE = 0.53;

function emptyResult(
  req: ReplayValidationRequest,
  reason: string,
  trades: readonly ReplayTrade[] = [],
): ReplayValidationResult {
  return Object.freeze({
    entryDigit: req.entryDigit,
    targetParity: req.targetParity,
    trades: trades.length,
    wins: 0,
    losses: trades.length,
    winRate: 0,
    longestWinStreak: 0,
    longestLossStreak: trades.length,
    outOfSample: Object.freeze({ trades: 0, wins: 0, winRate: 0 }),
    validated: false,
    reason,
    trades_: Object.freeze([...trades]),
  });
}

/**
 * Exact historical replay of "wait for `entryDigit`, then run the parity
 * contract for one tick". Pure and deterministic.
 */
export function replayParityEntryDigit(req: ReplayValidationRequest): ReplayValidationResult {
  const digits = req.digits;
  if (digits.length < 3) return emptyResult(req, "Not enough history to replay.");
  if (!Number.isInteger(req.entryDigit) || req.entryDigit < 0 || req.entryDigit > 9) {
    return emptyResult(req, `Invalid entry digit ${String(req.entryDigit)}.`);
  }

  const wantEven = req.targetParity === "EVEN";
  const trades: ReplayTrade[] = [];

  // OPEN -> SETTLE -> (skip settlement tick) -> OPEN ...
  let i = 0;
  while (i + 1 < digits.length) {
    if (digits[i] !== req.entryDigit) {
      i += 1;
      continue;
    }
    const openingIndex = i;
    const settlementIndex = i + 1;
    const settlementDigit = digits[settlementIndex]!;
    const win = (settlementDigit % 2 === 0) === wantEven;
    trades.push(
      Object.freeze({ openingIndex, settlementIndex, entryDigit: req.entryDigit, settlementDigit, win }),
    );
    // The settlement tick is consumed — never reused as the next opening tick.
    i = settlementIndex + 1;
  }

  if (trades.length === 0) return emptyResult(req, "Entry digit never triggered a trade.");

  let wins = 0;
  let winStreak = 0;
  let lossStreak = 0;
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  for (const t of trades) {
    if (t.win) {
      wins += 1;
      winStreak += 1;
      lossStreak = 0;
      longestWinStreak = Math.max(longestWinStreak, winStreak);
    } else {
      lossStreak += 1;
      winStreak = 0;
      longestLossStreak = Math.max(longestLossStreak, lossStreak);
    }
  }
  const winRate = wins / trades.length;

  const frac = Math.min(0.5, Math.max(0.1, req.oosFraction ?? 0.3));
  const oosStart = Math.floor(trades.length * (1 - frac));
  const oosTrades = trades.slice(oosStart);
  const oosWins = oosTrades.filter((t) => t.win).length;
  const oosWinRate = oosTrades.length > 0 ? oosWins / oosTrades.length : 0;

  const enoughTrades = trades.length >= MIN_TRADES;
  const clearsInSample = winRate >= MIN_WIN_RATE;
  const clearsOos = oosTrades.length === 0 ? false : oosWinRate >= 0.5;
  const validated = enoughTrades && clearsInSample && clearsOos;

  const reason = validated
    ? `Replay validated: ${wins}/${trades.length} (${(winRate * 100).toFixed(1)}%), out-of-sample ${(oosWinRate * 100).toFixed(1)}%.`
    : !enoughTrades
      ? `Only ${trades.length} replay trades — below the ${MIN_TRADES}-trade minimum.`
      : !clearsInSample
        ? `Replay win rate ${(winRate * 100).toFixed(1)}% is below the ${(MIN_WIN_RATE * 100).toFixed(0)}% bar.`
        : `Out-of-sample win rate ${(oosWinRate * 100).toFixed(1)}% did not hold up.`;

  return Object.freeze({
    entryDigit: req.entryDigit,
    targetParity: req.targetParity,
    trades: trades.length,
    wins,
    losses: trades.length - wins,
    winRate,
    longestWinStreak,
    longestLossStreak,
    outOfSample: Object.freeze({ trades: oosTrades.length, wins: oosWins, winRate: oosWinRate }),
    validated,
    reason,
    trades_: Object.freeze([...trades]),
  });
}

/** Default deterministic validator. Swap for the real DBot bridge later. */
export const localReplayValidator: EntryDigitReplayValidator = Object.freeze({
  id: "local-parity-replay",
  validate: replayParityEntryDigit,
});
