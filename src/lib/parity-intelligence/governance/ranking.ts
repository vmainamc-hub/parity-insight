/**
 * RANKING — PURE, NON-INGESTING
 * ====================================================================
 * Ranking answers ONLY "what is developing?" (§23/§37 Q1). It never
 * ingests, never mutates a cell, and never decides validity. A #1 cell may
 * be completely blocked; that stays visible.
 */
import type { CellRanking, ParityCellSnapshot } from "../types";

/**
 * Strength is a pure function of a snapshot: evidence net, confidence,
 * persistence and maturity. Governance is deliberately excluded so a
 * blocked cell can still be seen as the strongest developing hypothesis.
 */
export function cellStrength(cell: ParityCellSnapshot): number {
  if (cell.observationCount === 0) return 0;
  const maturityBonus =
    cell.maturity === "PEAK"
      ? 12
      : cell.maturity === "MATURE"
        ? 8
        : cell.maturity === "BUILDING"
          ? 4
          : cell.maturity === "WEAKENING"
            ? -8
            : cell.maturity === "EXPIRED"
              ? -20
              : 0;
  const persistenceBonus = Math.min(12, cell.persistenceTicks);
  const raw =
    cell.confidence * 0.6 +
    Math.max(0, cell.netEvidence) * 100 * 0.25 +
    persistenceBonus +
    maturityBonus -
    cell.conflictScore * 0.1;
  return Math.max(0, Math.min(100, raw));
}

export function rankCells(
  even: ParityCellSnapshot,
  odd: ParityCellSnapshot,
): readonly CellRanking[] {
  const entries = [
    { parity: even.parity, strength: cellStrength(even), blocked: even.hardVetoes.length > 0 },
    { parity: odd.parity, strength: cellStrength(odd), blocked: odd.hardVetoes.length > 0 },
  ].sort((a, b) => b.strength - a.strength || (a.parity === "EVEN" ? -1 : 1));

  return Object.freeze(
    entries.map((e, i) =>
      Object.freeze({ parity: e.parity, rank: (i + 1) as 1 | 2, strength: e.strength, blocked: e.blocked }),
    ),
  );
}

/** The strongest DEVELOPING cell — explicitly not "the valid signal". */
export function strongestCell(ranking: readonly CellRanking[]) {
  const top = ranking[0];
  if (!top || top.strength <= 0) return null;
  return top.parity;
}
