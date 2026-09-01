/**
 * PERSISTENT PARITY CELL
 * ====================================================================
 * One cell per (market, parity). BOTH cells always exist; the "losing"
 * hypothesis is never discarded (§4). A cell is a persistent observer
 * that answers "is there sufficient CONTINUING evidence that this parity
 * proposition is being delivered?" — not "which side scores highest now?"
 *
 * ISOLATED: nothing here is imported by the live application.
 */
import type {
  CellEvidenceTrace,
  CellHistoryPoint,
  CellObservation,
  ContradictionRecord,
  HardVeto,
  MaturityState,
  ParityCellSnapshot,
  ParityContextEvidence,
  ParityEvidence,
  Parity,
  SerializedCell,
  SoftBlocker,
  SupportLevel,
} from "../types";

const HISTORY_LIMIT = 240;
const CONTRADICTION_LIMIT = 40;

export function cellIdFor(marketId: string, parity: Parity): string {
  return `${marketId}_${parity}`;
}

export function observationKey(
  marketId: string,
  parity: Parity,
  analysisVersion: number,
  sourceTickId: string,
): string {
  return `${marketId}|${parity}|v${analysisVersion}|${sourceTickId}`;
}

interface MutableState {
  firstSeen: number;
  lastUpdated: number;
  observationCount: number;
  persistenceTicks: number;
  maturity: MaturityState;
  confidence: number;
  supportScore: number;
  conflictScore: number;
  netEvidence: number;
  supportStreak: number;
  cleanStreak: number;
  contradictionStreak: number;
  vetoStreak: number;
  meaningfulEvidenceTicks: number;
  engineAgreement: string[];
  engineDisagreement: string[];
  contradictions: ContradictionRecord[];
  evidenceTrace: CellEvidenceTrace[];
  hardVetoes: HardVeto[];
  softBlockers: SoftBlocker[];
  context: ParityContextEvidence | null;
  history: CellHistoryPoint[];
  lastSequence: number;
  lastObservationKey: string | null;
  seenKeys: string[];
  duplicateObservations: number;
  outOfOrderObservations: number;
}

function emptyState(now: number): MutableState {
  return {
    firstSeen: now,
    lastUpdated: now,
    observationCount: 0,
    persistenceTicks: 0,
    maturity: "EMERGING",
    confidence: 0,
    supportScore: 0,
    conflictScore: 0,
    netEvidence: 0,
    supportStreak: 0,
    cleanStreak: 0,
    contradictionStreak: 0,
    vetoStreak: 0,
    meaningfulEvidenceTicks: 0,
    engineAgreement: [],
    engineDisagreement: [],
    contradictions: [],
    evidenceTrace: [],
    hardVetoes: [],
    softBlockers: [],
    context: null,
    history: [],
    lastSequence: -1,
    lastObservationKey: null,
    seenKeys: [],
    duplicateObservations: 0,
    outOfOrderObservations: 0,
  };
}

export type IngestOutcome = "ACCEPTED" | "DUPLICATE" | "OUT_OF_ORDER" | "IDENTITY_MISMATCH";

export class ParityCell {
  /** Permanent identity — assigned once in the constructor, never rewritten. */
  readonly cellId: string;
  readonly marketId: string;
  readonly parity: Parity;

  private s: MutableState;

  constructor(marketId: string, parity: Parity, now = Date.now()) {
    this.marketId = marketId;
    this.parity = parity;
    this.cellId = cellIdFor(marketId, parity);
    this.s = emptyState(now);
    Object.freeze(this.cellId);
  }

  /**
   * Exactly-once observation (§7). A duplicate identity key, or a sequence
   * that is not strictly newer than the last accepted one, makes NO change
   * to tick count, maturity, persistence, confidence or evidence.
   */
  ingest(obs: CellObservation): IngestOutcome {
    if (obs.identity.marketId !== this.marketId || obs.identity.parity !== this.parity) {
      return "IDENTITY_MISMATCH";
    }
    if (this.s.seenKeys.includes(obs.identity.key)) {
      this.s.duplicateObservations += 1;
      return "DUPLICATE";
    }
    if (this.s.observationCount > 0 && obs.sequence <= this.s.lastSequence) {
      this.s.outOfOrderObservations += 1;
      return "OUT_OF_ORDER";
    }

    this.apply(obs);
    this.s.seenKeys.push(obs.identity.key);
    if (this.s.seenKeys.length > HISTORY_LIMIT) this.s.seenKeys.shift();
    this.s.lastObservationKey = obs.identity.key;
    this.s.lastSequence = obs.sequence;
    return "ACCEPTED";
  }

  private apply(obs: CellObservation): void {
    const s = this.s;
    if (s.observationCount === 0) s.firstSeen = obs.timestamp;
    s.observationCount += 1;
    s.lastUpdated = obs.timestamp;
    s.context = obs.context;

    const scored = scoreEvidence(this.parity, obs.evidence);
    s.evidenceTrace = scored.trace;
    s.engineAgreement = scored.agreeing;
    s.engineDisagreement = scored.opposing;
    s.supportScore = scored.supportScore;
    s.conflictScore = scored.conflictScore;
    s.netEvidence = scored.net;

    // Applicable governance for THIS parity only (null parity = both).
    s.hardVetoes = obs.hardVetoes.filter((v) => v.parity === null || v.parity === this.parity);
    s.softBlockers = obs.softBlockers.filter((b) => b.parity === null || b.parity === this.parity);

    const contradictions = deriveContradictions(this.parity, obs, scored, s.observationCount);
    for (const c of contradictions) {
      s.contradictions.push(c);
    }
    while (s.contradictions.length > CONTRADICTION_LIMIT) s.contradictions.shift();

    const hardContradiction =
      s.hardVetoes.length > 0 || contradictions.some((c) => c.kind === "HARD");
    const supported = scored.net > 0.05 && scored.supportScore >= 25;

    // Persistence only accrues while the proposition keeps being delivered.
    if (supported) {
      s.supportStreak += 1;
      s.persistenceTicks += 1;
    } else {
      s.supportStreak = 0;
      s.persistenceTicks = Math.max(0, s.persistenceTicks - 1);
    }
    if (hardContradiction) {
      s.contradictionStreak += 1;
      s.cleanStreak = 0;
    } else {
      s.contradictionStreak = 0;
      s.cleanStreak += 1;
    }
    s.vetoStreak = s.hardVetoes.length > 0 ? s.vetoStreak + 1 : 0;
    if (scored.meaningful) s.meaningfulEvidenceTicks += 1;

    // Confidence: evidence quality, damped by soft blockers. Never a proxy
    // for validity — validity lives in the governance layer.
    const penalty = Math.min(
      0.6,
      s.softBlockers.reduce((acc, b) => acc + b.penalty, 0),
    );
    const raw = Math.max(0, scored.supportScore - scored.conflictScore * 0.6);
    s.confidence = clamp(raw * (1 - penalty), 0, 100);

    s.maturity = nextMaturity(s.maturity, {
      persistence: s.persistenceTicks,
      confidence: s.confidence,
      supportStreak: s.supportStreak,
      contradictionStreak: s.contradictionStreak,
      supported,
      hardContradiction,
    });

    s.history.push(
      Object.freeze({
        sequence: obs.sequence,
        timestamp: obs.timestamp,
        confidence: s.confidence,
        netEvidence: s.netEvidence,
        maturity: s.maturity,
        hardVetoCount: s.hardVetoes.length,
      }),
    );
    if (s.history.length > HISTORY_LIMIT) s.history.shift();
  }

  snapshot(): ParityCellSnapshot {
    const s = this.s;
    const supportLevel: SupportLevel =
      s.observationCount === 0
        ? "UNKNOWN"
        : s.netEvidence > 0.15
          ? "SUPPORTING"
          : s.netEvidence < -0.15
            ? "OPPOSING"
            : "MIXED";
    return Object.freeze({
      cellId: this.cellId,
      marketId: this.marketId,
      parity: this.parity,
      firstSeen: s.firstSeen,
      lastUpdated: s.lastUpdated,
      observationCount: s.observationCount,
      persistenceTicks: s.persistenceTicks,
      maturity: s.maturity,
      confidence: s.confidence,
      supportScore: s.supportScore,
      conflictScore: s.conflictScore,
      netEvidence: s.netEvidence,
      supportLevel,
      supportStreak: s.supportStreak,
      cleanStreak: s.cleanStreak,
      contradictionStreak: s.contradictionStreak,
      vetoStreak: s.vetoStreak,
      meaningfulEvidenceTicks: s.meaningfulEvidenceTicks,
      engineAgreement: Object.freeze([...s.engineAgreement]),
      engineDisagreement: Object.freeze([...s.engineDisagreement]),
      contradictions: Object.freeze([...s.contradictions]),
      evidenceTrace: Object.freeze([...s.evidenceTrace]),
      hardVetoes: Object.freeze([...s.hardVetoes]),
      softBlockers: Object.freeze([...s.softBlockers]),
      context: s.context,
      regimeCompatible: s.context ? s.context.regimeCompatible[this.parity] : true,
      statisticalAuthority: s.context ? statisticalAuthority(s.context) : 0,
      history: Object.freeze([...s.history]),
      lastObservationKey: s.lastObservationKey,
      duplicateObservations: s.duplicateObservations,
      outOfOrderObservations: s.outOfOrderObservations,
    });
  }

  serialize(): SerializedCell {
    return {
      cellId: this.cellId,
      marketId: this.marketId,
      parity: this.parity,
      state: JSON.parse(JSON.stringify(this.s)) as unknown,
    };
  }

  hydrate(payload: SerializedCell): void {
    if (payload.marketId !== this.marketId || payload.parity !== this.parity) {
      throw new Error(
        `Cannot hydrate ${this.cellId} from ${payload.cellId}: cell identity is permanent.`,
      );
    }
    this.s = { ...emptyState(Date.now()), ...(payload.state as MutableState) };
  }

  reset(now = Date.now()): void {
    this.s = emptyState(now);
  }
}

function statisticalAuthority(ctx: ParityContextEvidence): number {
  switch (ctx.statisticalStrength) {
    case "STRONG":
      return 1;
    case "MODERATE":
      return 0.6;
    case "WEAK":
      return 0.3;
    default:
      return 0;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

export interface ScoredEvidence {
  readonly trace: CellEvidenceTrace[];
  readonly agreeing: string[];
  readonly opposing: string[];
  readonly supportScore: number;
  readonly conflictScore: number;
  readonly net: number;
  readonly meaningful: boolean;
}

/**
 * Normalized evidence -> per-cell support/conflict.
 *
 * Correlated engines never manufacture confidence (§10): within one
 * correlation group only the strongest observer counts at full weight and
 * every further member is attenuated. META/GATE/CONTEXT engines never vote
 * on direction — they only modulate or block elsewhere.
 */
export function scoreEvidence(
  parity: Parity,
  evidence: readonly ParityEvidence[],
): ScoredEvidence {
  const opposite = parity === "EVEN" ? "ODD" : "EVEN";
  const trace: CellEvidenceTrace[] = [];
  const agreeing: string[] = [];
  const opposing: string[] = [];

  const directional = evidence.filter((e) => e.authority === "DIRECT");
  const groupSeen = new Map<string, number>();

  let support = 0;
  let conflict = 0;
  let totalWeight = 0;

  const ordered = [...directional].sort(
    (a, b) => b.strength * b.confidence - a.strength * a.confidence,
  );

  for (const e of ordered) {
    const seen = groupSeen.get(e.correlationGroup) ?? 0;
    groupSeen.set(e.correlationGroup, seen + 1);
    // First member of a correlation group counts fully; each subsequent one
    // is attenuated so redundant observers cannot inflate confidence.
    const decorrelationFactor = 1 / (1 + seen);
    const base = e.strength * (0.4 + 0.6 * e.confidence) * (0.4 + 0.6 * e.sampleAuthority);
    const weight = base * decorrelationFactor;
    totalWeight += weight;

    if (e.direction === parity && weight > 0) {
      support += weight;
      agreeing.push(e.engine);
      trace.push({ engine: e.engine, family: e.family, relation: "SUPPORT", weight, detail: e.detail });
    } else if (e.direction === opposite && weight > 0) {
      conflict += weight;
      opposing.push(e.engine);
      trace.push({ engine: e.engine, family: e.family, relation: "OPPOSE", weight, detail: e.detail });
    } else {
      trace.push({ engine: e.engine, family: e.family, relation: "NEUTRAL", weight: 0, detail: e.detail });
    }
  }

  const denom = totalWeight > 0 ? totalWeight : 1;
  const supportScore = clamp((support / denom) * 100, 0, 100);
  const conflictScore = clamp((conflict / denom) * 100, 0, 100);
  const net = clamp((support - conflict) / denom, -1, 1);

  return {
    trace,
    agreeing,
    opposing,
    supportScore,
    conflictScore,
    net,
    meaningful: support > 0 && agreeing.length >= 2,
  };
}

/**
 * Contradictions are recorded, never averaged away (§13). A HARD
 * contradiction remains visible in the snapshot even when the numeric
 * confidence is high.
 */
export function deriveContradictions(
  parity: Parity,
  obs: CellObservation,
  scored: ScoredEvidence,
  atTick: number,
): ContradictionRecord[] {
  const out: ContradictionRecord[] = [];
  const ctx = obs.context;

  if (scored.supportScore >= 40 && scored.conflictScore >= 40) {
    out.push({
      code: "SPLIT_EVIDENCE",
      kind: "SOFT",
      detail: `Support ${scored.supportScore.toFixed(0)} vs conflict ${scored.conflictScore.toFixed(0)} — engines are divided.`,
      atTick,
    });
  }
  if (scored.net > 0.15 && !ctx.regimeCompatible[parity]) {
    out.push({
      code: "REGIME_INCOMPATIBLE",
      kind: "HARD",
      detail: `${parity} evidence is accumulating inside an incompatible regime (${ctx.regime}/${ctx.hiddenRegime}).`,
      atTick,
    });
  }
  if (scored.net > 0.15 && ctx.dangerCritical) {
    out.push({
      code: "DANGER_CONTRADICTION",
      kind: "HARD",
      detail: `${parity} evidence is strong while danger is critical (${ctx.dangerScore.toFixed(0)}).`,
      atTick,
    });
  }
  if (scored.net > 0.15 && ctx.driftBreakDetected && ctx.driftSeverity === "MAJOR") {
    out.push({
      code: "DRIFT_INVALIDATES_MODEL",
      kind: "HARD",
      detail: `${parity} evidence rests on a model invalidated by major drift.`,
      atTick,
    });
  }
  if (
    ctx.multiHorizon.alignment === "CONTRADICTORY" &&
    (ctx.multiHorizon.short === parity || ctx.multiHorizon.long === parity)
  ) {
    out.push({
      code: "HORIZON_CONTRADICTION",
      kind: "SOFT",
      detail: `Short horizon ${ctx.multiHorizon.short} contradicts long horizon ${ctx.multiHorizon.long}.`,
      atTick,
    });
  }
  if (scored.net > 0.15 && ctx.statisticalStrength === "INSUFFICIENT") {
    out.push({
      code: "NO_STATISTICAL_BACKING",
      kind: "HARD",
      detail: "Directional evidence without sufficient sample authority.",
      atTick,
    });
  }
  return out;
}

interface MaturityInput {
  readonly persistence: number;
  readonly confidence: number;
  readonly supportStreak: number;
  readonly contradictionStreak: number;
  readonly supported: boolean;
  readonly hardContradiction: boolean;
}

/**
 * Maturity mirrors the existing `updateMaturity` ladder in
 * `precision-parity/engine.ts` (persistence >= 12 & conf >= 78 -> PEAK,
 * >= 6 & >= 68 -> MATURE, >= 3 -> BUILDING, conf < 55 -> WEAKENING) and adds
 * the lifecycle terminal EXPIRED for a cell that stops being delivered.
 * One isolated impressive tick can never produce maturity.
 */
export function nextMaturity(current: MaturityState, i: MaturityInput): MaturityState {
  if (i.contradictionStreak >= 5) return "EXPIRED";
  if (!i.supported && (current === "WEAKENING" || current === "EXPIRED") && i.persistence === 0) {
    return "EXPIRED";
  }
  if (i.confidence < 55 || i.hardContradiction) return "WEAKENING";
  if (i.persistence >= 12 && i.confidence >= 78) return "PEAK";
  if (i.persistence >= 6 && i.confidence >= 68) return "MATURE";
  if (i.persistence >= 3) return "BUILDING";
  return "EMERGING";
}
