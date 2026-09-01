/**
 * PARITY INTELLIGENCE — PUBLIC SURFACE OF THE ISOLATED SUBSYSTEM
 * ====================================================================
 * NOTHING in the live application imports this file yet. It exists so the
 * future integration pass has exactly one entry point.
 *
 * INPUT :  CanonicalParitySnapshot
 * CALL  :  analyzeParityIntelligence(snapshot, { registry, sentinel })
 * OUTPUT:  ParityIntelligenceSnapshot (immutable)
 * THEN  :  feed ONLY `admission === "ADMITTED"` results into the existing
 *          signal arbitration layer. See docs/PARITY-INTELLIGENCE.md.
 */
export * from "./types";
export { ENGINE_ROLES, ENGINE_INVENTORY, getEngineRole } from "./engine-registry";
export { runEngines, isRegimeCompatible, intelligenceMarketKey } from "./evidence/engine-runner";
export { ParityCell, cellIdFor, observationKey, scoreEvidence, nextMaturity } from "./cells/cell";
export {
  ParityCellRegistry,
  makeObservationIdentity,
  fallbackSourceTickId,
} from "./cells/registry";
export { evaluateGates } from "./governance/gates";
export { cellStrength, rankCells, strongestCell } from "./governance/ranking";
export { projectSentinelDossier } from "./sentinel/projection";
export { crossConfirm, crossConfirmAll, cellSupportLevel } from "./sentinel/bridge";
export { evaluateEntryDigit } from "./entry/entry-digit";
export { replayParityEntryDigit, localReplayValidator } from "./dbot/replay-validator";
export { analyzeParityIntelligence } from "./orchestrator";
export type { AnalyzeOptions } from "./orchestrator";
export {
  runShadowReplay,
  summarizeShadowReplay,
  makeSyntheticSnapshots,
} from "./shadow/harness";
export type { ShadowComparison, ShadowSummary, CurrentPipelineRead } from "./shadow/harness";
