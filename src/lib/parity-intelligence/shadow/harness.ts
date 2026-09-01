/**
 * SHADOW / REPLAY HARNESS (§28)
 * ====================================================================
 * Lets the new intelligence layer be replayed over historical, fixture or
 * synthetic snapshots and compared against whatever the current pipeline says
 * — WITHOUT changing what the application does. The current pipeline is
 * supplied as an injected reader, so the harness never creates a second live
 * data pipeline, WebSocket subscription or analysis loop.
 */
import { ParityCellRegistry } from "./../cells/registry";
import { analyzeParityIntelligence, type AnalyzeOptions } from "./../orchestrator";
import type {
  CanonicalParitySnapshot,
  ParityIntelligenceSnapshot,
  ReadonlySentinelProjection,
} from "./../types";

/** What the harness needs to know about the CURRENT pipeline's verdict. */
export interface CurrentPipelineRead {
  readonly direction: "EVEN" | "ODD" | "NEUTRAL" | "NO_TRADE";
  readonly confidence: number;
  readonly admitted: boolean;
  readonly label?: string;
}

export interface ShadowComparison {
  readonly sourceTickId: string;
  readonly analysisVersion: number;
  readonly current: CurrentPipelineRead | null;
  readonly newStrongestCell: "EVEN" | "ODD" | null;
  readonly newMaturity: string | null;
  readonly newConfidence: number;
  readonly newQualification: ParityIntelligenceSnapshot["qualification"];
  readonly newAdmission: ParityIntelligenceSnapshot["admission"];
  readonly newHardVetoes: readonly string[];
  readonly newSoftBlockers: readonly string[];
  readonly newCrossConfirmation: readonly string[];
  readonly newEntryDigitReady: boolean;
  readonly newEntryDigit: number | null;
  readonly agreesWithCurrent: boolean | null;
  readonly snapshot: ParityIntelligenceSnapshot;
}

export interface ShadowRunOptions {
  /** Read-only Sentinel projections per snapshot index. */
  readonly sentinelFor?: (s: CanonicalParitySnapshot) => readonly ReadonlySentinelProjection[];
  /** Injected current-pipeline verdict. Omit to run the new layer alone. */
  readonly currentFor?: (s: CanonicalParitySnapshot) => CurrentPipelineRead | null;
  readonly analyzeOptions?: Omit<AnalyzeOptions, "registry" | "sentinel">;
}

/**
 * Replay a sequence of canonical snapshots through ONE persistent registry so
 * cell persistence, maturity and streaks develop exactly as they would live.
 */
export function runShadowReplay(
  snapshots: readonly CanonicalParitySnapshot[],
  options: ShadowRunOptions = {},
): readonly ShadowComparison[] {
  const registry = new ParityCellRegistry();
  const out: ShadowComparison[] = [];

  for (const snapshot of snapshots) {
    const result = analyzeParityIntelligence(snapshot, {
      ...options.analyzeOptions,
      registry,
      sentinel: options.sentinelFor?.(snapshot) ?? [],
    });
    const current = options.currentFor?.(snapshot) ?? null;
    const strongest = result.strongestCell;
    const cell = strongest === "EVEN" ? result.even : strongest === "ODD" ? result.odd : null;

    out.push(
      Object.freeze({
        sourceTickId: snapshot.sourceTickId,
        analysisVersion: snapshot.analysisVersion,
        current,
        newStrongestCell: strongest,
        newMaturity: cell ? cell.maturity : null,
        newConfidence: cell ? cell.confidence : 0,
        newQualification: result.qualification,
        newAdmission: result.admission,
        newHardVetoes: Object.freeze(result.hardVetoes.map((v) => v.code)),
        newSoftBlockers: Object.freeze(result.softBlockers.map((b) => b.code)),
        newCrossConfirmation: Object.freeze(
          result.crossConfirmation.map((c) => `${c.proposition}:${c.verdict}`),
        ),
        newEntryDigitReady: result.entryDigit.evaluated,
        newEntryDigit: result.entryDigit.entryDigit,
        agreesWithCurrent: current ? current.direction === (strongest ?? "NO_TRADE") : null,
        snapshot: result,
      }),
    );
  }

  return Object.freeze(out);
}

export interface ShadowSummary {
  readonly observations: number;
  readonly admitted: number;
  readonly blocked: number;
  readonly developing: number;
  readonly noValidSetup: number;
  readonly agreementRate: number | null;
  readonly vetoCodes: Readonly<Record<string, number>>;
}

export function summarizeShadowReplay(rows: readonly ShadowComparison[]): ShadowSummary {
  const vetoCodes: Record<string, number> = {};
  let admitted = 0;
  let blocked = 0;
  let developing = 0;
  let noValid = 0;
  let comparable = 0;
  let agreed = 0;

  for (const r of rows) {
    if (r.newAdmission === "ADMITTED") admitted += 1;
    if (r.newQualification === "BLOCKED") blocked += 1;
    if (r.newQualification === "DEVELOPING" || r.newQualification === "CANDIDATE") developing += 1;
    if (r.newQualification === "NO_VALID_SETUP") noValid += 1;
    for (const code of r.newHardVetoes) vetoCodes[code] = (vetoCodes[code] ?? 0) + 1;
    if (r.agreesWithCurrent !== null) {
      comparable += 1;
      if (r.agreesWithCurrent) agreed += 1;
    }
  }

  return Object.freeze({
    observations: rows.length,
    admitted,
    blocked,
    developing,
    noValidSetup: noValid,
    agreementRate: comparable > 0 ? agreed / comparable : null,
    vetoCodes: Object.freeze(vetoCodes),
  });
}

/** Deterministic synthetic snapshot builder for fixtures/tests. */
export function makeSyntheticSnapshots(
  symbol: string,
  digits: readonly number[],
  opts: { readonly window?: number; readonly steps?: number; readonly startTime?: number } = {},
): readonly CanonicalParitySnapshot[] {
  const window = opts.window ?? 600;
  const steps = opts.steps ?? 10;
  const startTime = opts.startTime ?? 1_700_000_000_000;
  const out: CanonicalParitySnapshot[] = [];

  for (let step = 0; step < steps; step++) {
    const end = Math.min(digits.length, window + step);
    const slice = digits.slice(Math.max(0, end - window), end);
    const timestamp = startTime + step * 1000;
    out.push(
      Object.freeze({
        symbol,
        displayName: symbol,
        digits: Object.freeze([...slice]),
        ticks: Object.freeze(
          slice.map((d, i) => ({ time: timestamp - (slice.length - i) * 1000, price: 1000 + d / 10 })),
        ) as CanonicalParitySnapshot["ticks"],
        sourceTickId: `${symbol}-${end}`,
        analysisVersion: step + 1,
        timestamp,
        payoutRate: 0.95,
      }),
    );
  }
  return Object.freeze(out);
}
