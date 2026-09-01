/**
 * SENTINEL -> PARITY READ-ONLY PROJECTION
 * ====================================================================
 * Sentinel remains the structural authority (§16). This module NEVER
 * ingests, mutates, advances, re-ranks or re-qualifies a Sentinel cell and
 * never recomputes Sentinel mathematics. It takes an already-produced
 * `ObservationDossier` and copies out a deep-frozen structural subset that
 * the parity bridge is allowed to read.
 *
 * Type-only imports are used so no Sentinel runtime module is pulled in.
 */
import type { ObservationDossier } from "@/lib/sentinel/observation/types";
import type { CellIdentity } from "@/lib/sentinel/observation/cellIdentity";
import type { ReadonlySentinelProjection } from "../types";

/** Minimal read surface the projection needs. Anything else is ignored. */
export type ProjectableDossier = Pick<
  ObservationDossier,
  "cellId" | "marketId" | "proposition" | "state" | "score" | "isRipe"
> & {
  identity?: CellIdentity;
  regime?: { compatibility?: ObservationDossier["regime"]["compatibility"] };
  veto?: { active?: boolean; hard?: boolean };
};

/**
 * Build the read-only projection. Returns `null` when the dossier carries no
 * permanent `identity` — a projection is never fabricated (parity support must
 * be judged against real winning/losing digit sets, never a contract name).
 */
export function projectSentinelDossier(
  dossier: ProjectableDossier,
): ReadonlySentinelProjection | null {
  const id = dossier.identity;
  if (!id) return null;

  return Object.freeze({
    cellId: String(dossier.cellId),
    marketId: String(dossier.marketId),
    proposition: String(dossier.proposition),
    state: String(dossier.state),
    score: Number(dossier.score) || 0,
    isRipe: Boolean(dossier.isRipe),
    hardVetoActive: Boolean(dossier.veto?.active && dossier.veto?.hard),
    regimeCompatibility: dossier.regime?.compatibility ?? "NEUTRAL_UNCERTAIN",
    identity: Object.freeze({
      winningDigits: Object.freeze([...id.winningDigits]),
      losingDigits: Object.freeze([...id.losingDigits]),
      greenParity: id.greenParity,
      secondGreenParity: id.secondGreenParity,
      redParity: id.redParity,
      extremeDigit: id.extremeDigit,
      redExcludedDigit: id.redExcludedDigit,
      edgeGroup: Object.freeze([...id.edgeGroup]),
    }),
  });
}
