import { describe, it, expect } from "vitest";
import {
  runValidationChecks,
  buildReinvestigationBrief,
  type ValidationInput,
} from "../src/domain/validate";

/**
 * The baseline is S1-A executed correctly: 250 units from Meridian at 450,
 * against the state the seed creates. Every case below is that baseline with a
 * single field perturbed, so each test isolates exactly one check.
 */
const s1aValid: ValidationInput = {
  poQuantity: 250,
  poUnitPrice: 450,
  poSupplierId: "sup_meridian",
  poSupplierName: "Meridian Distributors",
  agentStatedQuantity: 250,
  supplierMoq: 100,
  supplierLotSize: 50,
  supplierSuppliesProduct: true,
  onHand: 120,
  reserved: 20,
  forecastUnits: 500,
  safetyStock: 50,
  otherIncoming: 100,
  storageCapacity: 500,
  storageUsed: 120,
  budgetTotal: 245_000,
  budgetUsedExcludingThisPo: 45_000,
};

describe("validator — correctly executed S1-A", () => {
  const r = runValidationChecks(s1aValid);

  it("passes every check", () => {
    expect(r.passed).toBe(true);
    expect(r.failedIds).toEqual([]);
    expect(r.checks).toHaveLength(8);
  });

  it("reports headroom recomputed at validation time", () => {
    // 500 - 120 - 100 = 280, and the order of 250 fits.
    expect(r.checks.find((c) => c.id === "V4")?.detail).toContain("280");
  });

  it("does not overshoot demand", () => {
    // position 100 + 100 + 250 = 450 against demand 550, ceiling 660.
    const v6 = r.checks.find((c) => c.id === "V6");
    expect(v6?.passed).toBe(true);
    expect(v6?.detail).toContain("450");
  });
});

describe("validator — structural failures", () => {
  it("V1 rejects a zero-quantity order", () => {
    const r = runValidationChecks({ ...s1aValid, poQuantity: 0 });
    expect(r.failedIds).toContain("V1");
  });

  it("V2 rejects an order below the supplier minimum", () => {
    const r = runValidationChecks({
      ...s1aValid,
      poQuantity: 50,
      agentStatedQuantity: 50,
    });
    expect(r.failedIds).toContain("V2");
  });

  it("V3 rejects a quantity that is not a whole lot", () => {
    const r = runValidationChecks({
      ...s1aValid,
      poQuantity: 275,
      agentStatedQuantity: 275,
    });
    expect(r.failedIds).toContain("V3");
    expect(r.checks.find((c) => c.id === "V3")?.detail).toContain("remainder of 25");
  });

  it("V8 rejects a supplier with no terms for the product", () => {
    const r = runValidationChecks({
      ...s1aValid,
      supplierSuppliesProduct: false,
    });
    expect(r.failedIds).toContain("V8");
  });

  it("ignores lot size when the supplier imposes none", () => {
    const r = runValidationChecks({
      ...s1aValid,
      supplierLotSize: 1,
      poQuantity: 237,
      agentStatedQuantity: 237,
    });
    expect(r.checks.find((c) => c.id === "V3")?.passed).toBe(true);
  });
});

describe("validator — reconciliation against the agent's decision", () => {
  it("V7 catches an order that does not match what the agent decided", () => {
    const r = runValidationChecks({ ...s1aValid, poQuantity: 300 });
    expect(r.failedIds).toContain("V7");
    expect(r.checks.find((c) => c.id === "V7")?.detail).toContain("300");
  });

  it("V7 fails when the agent never committed to a quantity", () => {
    const r = runValidationChecks({ ...s1aValid, agentStatedQuantity: null });
    expect(r.failedIds).toContain("V7");
  });
});

describe("validator — state drift between decision and execution", () => {
  /**
   * These are the cases that make the feedback loop real. The agent reasoned
   * correctly against the state it saw; the world moved underneath it.
   */

  it("V5 fails when budget was consumed after the agent investigated", () => {
    // Another buyer committed 150,000 in the meantime.
    const r = runValidationChecks({
      ...s1aValid,
      budgetUsedExcludingThisPo: 195_000,
    });
    expect(r.passed).toBe(false);
    expect(r.failedIds).toEqual(["V5"]);
    expect(r.checks.find((c) => c.id === "V5")?.stateSensitive).toBe(true);
  });

  it("V4 fails when storage filled up after the agent investigated", () => {
    // A delivery landed: storageUsed rose from 120 to 300.
    const r = runValidationChecks({ ...s1aValid, storageUsed: 300 });
    expect(r.passed).toBe(false);
    expect(r.failedIds).toEqual(["V4"]);
  });

  it("V6 fails when another order arrived covering the same demand", () => {
    // otherIncoming jumped from 100 to 500; position would reach 850 vs a 660 ceiling.
    const r = runValidationChecks({
      ...s1aValid,
      otherIncoming: 500,
      storageCapacity: 5000,
      storageUsed: 0,
    });
    expect(r.failedIds).toContain("V6");
  });

  it("distinguishes state-sensitive failures from structural ones", () => {
    const drifted = runValidationChecks({
      ...s1aValid,
      budgetUsedExcludingThisPo: 195_000,
    });
    const structural = runValidationChecks({
      ...s1aValid,
      supplierSuppliesProduct: false,
    });

    expect(drifted.checks.filter((c) => !c.passed).every((c) => c.stateSensitive)).toBe(true);
    expect(structural.checks.filter((c) => !c.passed).every((c) => c.stateSensitive)).toBe(false);
  });
});

describe("re-investigation brief", () => {
  it("tells the agent to re-read state after a drift failure", () => {
    const outcome = runValidationChecks({
      ...s1aValid,
      budgetUsedExcludingThisPo: 195_000,
    });
    const brief = buildReinvestigationBrief(outcome, {
      poQuantity: 250,
      supplierName: "Meridian Distributors",
    });

    expect(brief).toContain("V5");
    expect(brief).toContain("state-sensitive");
    expect(brief).toContain("do not reuse the earlier snapshot");
  });

  it("names a structural failure as structural", () => {
    const outcome = runValidationChecks({
      ...s1aValid,
      poQuantity: 275,
      agentStatedQuantity: 275,
    });
    const brief = buildReinvestigationBrief(outcome, {
      poQuantity: 275,
      supplierName: "Meridian Distributors",
    });

    expect(brief).toContain("structural");
  });

  it("does not tell the agent what quantity to pick", () => {
    // The brief supplies evidence, not an answer. Deciding is the agent's job.
    const outcome = runValidationChecks({ ...s1aValid, storageUsed: 300 });
    const brief = buildReinvestigationBrief(outcome, {
      poQuantity: 250,
      supplierName: "Meridian Distributors",
    });

    expect(brief).not.toMatch(/order \d+ units instead/i);
    expect(brief).toContain("Re-read the current figures");
  });
});