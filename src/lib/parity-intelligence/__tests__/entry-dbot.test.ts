/**
 * ENTRY-DIGIT + DBOT REPLAY TESTS (§24/§25/§29)
 */
import { describe, expect, it } from "vitest";
import { ParityCell } from "../cells/cell";
import { evaluateEntryDigit } from "../entry/entry-digit";
import { localReplayValidator, replayParityEntryDigit } from "../dbot/replay-validator";
import type { CanonicalParitySnapshot } from "../types";
import { evenEvidence, observation } from "./fixtures";

function digitsFrom(seed: number, n: number): number[] {
  const out: number[] = [];
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(Math.floor(x / 65536) % 10);
  }
  return out;
}

function snap(digits: readonly number[]): CanonicalParitySnapshot {
  return Object.freeze({
    symbol: "R_100",
    displayName: "Volatility 100",
    digits: Object.freeze([...digits]),
    ticks: Object.freeze([]) as CanonicalParitySnapshot["ticks"],
    sourceTickId: `t-${digits.length}`,
    analysisVersion: 1,
    timestamp: 1_700_000_000_000,
    payoutRate: 0.95,
  });
}

function grownCell(ticks = 8) {
  const cell = new ParityCell("R_100", "EVEN");
  for (let i = 1; i <= ticks; i++) cell.ingest(observation("EVEN", i, evenEvidence));
  return cell.snapshot();
}

describe("entry digit is strictly downstream", () => {
  it("refuses to run without a cell", () => {
    const r = evaluateEntryDigit({
      snapshot: snap(digitsFrom(1, 400)),
      cell: null,
      cellDirectionEstablished: true,
    });
    expect(r.evaluated).toBe(false);
    expect(r.entryDigit).toBeNull();
  });

  it("refuses to run before the cell establishes a legitimate direction", () => {
    const r = evaluateEntryDigit({
      snapshot: snap(digitsFrom(2, 400)),
      cell: grownCell(),
      cellDirectionEstablished: false,
    });
    expect(r.evaluated).toBe(false);
    expect(r.reason).toMatch(/downstream/i);
  });

  it("cannot make an invalid parity cell valid — it only reports readiness", () => {
    const cell = grownCell();
    const ready = evaluateEntryDigit({
      snapshot: snap(digitsFrom(3, 400)),
      cell,
      cellDirectionEstablished: true,
    });
    // Even a fully evaluated digit carries no qualification/admission authority.
    expect(Object.keys(ready)).not.toContain("qualification");
    expect(Object.keys(ready)).not.toContain("admission");
    expect(ready.targetContract).toBe("DIGITEVEN");
  });

  it("requires sufficient digit history", () => {
    const r = evaluateEntryDigit({
      snapshot: snap(digitsFrom(4, 20)),
      cell: grownCell(),
      cellDirectionEstablished: true,
    });
    expect(r.evaluated).toBe(false);
    expect(r.reason).toMatch(/insufficient/i);
  });
});

describe("dbot replay cadence", () => {
  it("opens on the entry digit and settles on the very next tick", () => {
    const r = replayParityEntryDigit({ digits: [7, 2, 9, 3], entryDigit: 7, targetParity: "EVEN" });
    expect(r.trades_[0]).toMatchObject({ openingIndex: 0, settlementIndex: 1, win: true });
  });

  it("never reuses a settlement tick as the next opening tick", () => {
    // digits: 7 7 7 7 -> opens at 0 (settles 1), next open may only be index 2.
    const r = replayParityEntryDigit({ digits: [7, 7, 7, 7], entryDigit: 7, targetParity: "ODD" });
    expect(r.trades).toBe(2);
    expect(r.trades_.map((t) => t.openingIndex)).toEqual([0, 2]);
    expect(r.trades_.map((t) => t.settlementIndex)).toEqual([1, 3]);
    const settlements = new Set(r.trades_.map((t) => t.settlementIndex));
    for (const t of r.trades_) expect(settlements.has(t.openingIndex)).toBe(false);
  });

  it("is deterministic and frozen", () => {
    const req = { digits: digitsFrom(5, 500), entryDigit: 3, targetParity: "EVEN" } as const;
    const a = localReplayValidator.validate(req);
    const b = localReplayValidator.validate(req);
    expect(a).toEqual(b);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it("does not validate on too few trades", () => {
    const r = replayParityEntryDigit({ digits: [7, 2, 5, 7, 4], entryDigit: 7, targetParity: "EVEN" });
    expect(r.validated).toBe(false);
    expect(r.reason).toMatch(/minimum/i);
  });

  it("rejects an invalid entry digit and short history", () => {
    expect(
      replayParityEntryDigit({ digits: [1, 2, 3], entryDigit: 42, targetParity: "EVEN" }).validated,
    ).toBe(false);
    expect(
      replayParityEntryDigit({ digits: [1], entryDigit: 1, targetParity: "EVEN" }).reason,
    ).toMatch(/not enough history/i);
  });

  it("validates a perfectly deterministic winning sequence", () => {
    // Entry digit 1 is always followed by an even digit -> every trade wins.
    const digits: number[] = [];
    for (let i = 0; i < 40; i++) digits.push(1, 2, 3);
    const r = replayParityEntryDigit({ digits, entryDigit: 1, targetParity: "EVEN" });
    expect(r.winRate).toBe(1);
    expect(r.validated).toBe(true);
  });
});
