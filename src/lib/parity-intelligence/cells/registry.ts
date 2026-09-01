/**
 * PARITY CELL REGISTRY
 * ====================================================================
 * Owns the persistent EVEN/ODD cell universe. Two cells per market, always
 * both, forever (§4/§6). No database dependency — serialize()/hydrate()
 * are the seams a later persistence pass wires up.
 */
import { ParityCell, cellIdFor, observationKey } from "./cell";
import type {
  CanonicalParitySnapshot,
  CellObservation,
  ObservationIdentity,
  ParityCellSnapshot,
  Parity,
  SerializedCell,
} from "../types";

const PARITIES: readonly Parity[] = ["EVEN", "ODD"];

export class ParityCellRegistry {
  private readonly cells = new Map<string, ParityCell>();

  getCell(marketId: string, parity: Parity): ParityCell {
    const id = cellIdFor(marketId, parity);
    let cell = this.cells.get(id);
    if (!cell) {
      cell = new ParityCell(marketId, parity);
      this.cells.set(id, cell);
    }
    return cell;
  }

  /** Ensures both cells exist for a market; the weaker one is never dropped. */
  ensureMarket(marketId: string): readonly ParityCell[] {
    return PARITIES.map((p) => this.getCell(marketId, p));
  }

  ingest(observation: CellObservation) {
    const cell = this.getCell(observation.identity.marketId, observation.identity.parity);
    return cell.ingest(observation);
  }

  getCellSnapshot(marketId: string, parity: Parity): ParityCellSnapshot {
    return this.getCell(marketId, parity).snapshot();
  }

  getAllCells(marketId?: string): readonly ParityCellSnapshot[] {
    const all = [...this.cells.values()];
    const scoped = marketId ? all.filter((c) => c.marketId === marketId) : all;
    return Object.freeze(scoped.map((c) => c.snapshot()));
  }

  serialize(marketId?: string): readonly SerializedCell[] {
    const all = [...this.cells.values()];
    const scoped = marketId ? all.filter((c) => c.marketId === marketId) : all;
    return Object.freeze(scoped.map((c) => c.serialize()));
  }

  hydrate(payloads: readonly SerializedCell[]): void {
    for (const p of payloads) {
      this.getCell(p.marketId, p.parity).hydrate(p);
    }
  }

  reset(marketId?: string): void {
    if (!marketId) {
      this.cells.clear();
      return;
    }
    for (const [id, cell] of this.cells) {
      if (cell.marketId === marketId) this.cells.delete(id);
    }
  }
}

/**
 * Build the exactly-once identity of one observation from the canonical
 * snapshot's strongest available source identifiers (§7).
 */
export function makeObservationIdentity(
  source: Pick<CanonicalParitySnapshot, "symbol" | "analysisVersion" | "sourceTickId"> & {
    digits?: readonly number[];
    timestamp?: number;
  },
  parity: Parity,
): ObservationIdentity {
  const marketId = source.symbol;
  const analysisVersion = source.analysisVersion;
  const sourceTickId =
    source.sourceTickId && source.sourceTickId.length > 0
      ? source.sourceTickId
      : fallbackSourceTickId(source.digits ?? [], source.timestamp ?? 0);
  return Object.freeze({
    marketId,
    parity,
    analysisVersion,
    sourceTickId,
    key: observationKey(marketId, parity, analysisVersion, sourceTickId),
  });
}

/** Deterministic fallback identity when no source tick id is available. */
export function fallbackSourceTickId(digits: readonly number[], timestamp: number): string {
  let h = 2166136261;
  for (const d of digits) {
    h ^= d + 1;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `fb-${digits.length}-${h.toString(16)}-${timestamp}`;
}

export { ParityCell, cellIdFor, observationKey };
