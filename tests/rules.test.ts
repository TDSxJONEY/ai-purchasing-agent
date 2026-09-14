import { describe, it, expect } from "vitest";
import {
  roundUpToLot,
  roundDownToLot,
  assessEvidence,
  decidePurchase,
  decidePartialFulfilment,
  type PurchaseSituation,
  type SupplierTerms,
} from "../src/domain/rules";

/**
 * Ground-truth suite for docs/decision-spec.md §8.
 *
 * Every expectation here was derived by hand from the spec BEFORE the
 * implementation was written. These are the reference answers the agent's
 * decisions are graded against in the evaluation suite.
 */

const DAY = 24 * 60 * 60 * 1000;
/** Fixed clock so forecast-age assertions never drift. */
const NOW = new Date("2026-01-15T00:00:00.000Z");
const daysBefore = (n: number) => new Date(NOW.getTime() - n * DAY);

const meridianEarbuds: SupplierTerms = {
  supplierId: "sup_meridian",
  supplierName: "Meridian Distributors",
  unitPrice: 450,
  moq: 100,
  lotSize: 50,
  leadTimeDays: 2,
};

describe("lot rounding", () => {
  it("rounds up to the next lot when meeting demand", () => {
    expect(roundUpToLot(350, 50)).toBe(350);
    expect(roundUpToLot(351, 50)).toBe(400);
    expect(roundUpToLot(1, 50)).toBe(50);
    expect(roundUpToLot(0, 50)).toBe(0);
  });

  it("rounds down to the previous lot when capping", () => {
    expect(roundDownToLot(280, 50)).toBe(250);
    expect(roundDownToLot(300, 50)).toBe(300);
    expect(roundDownToLot(49, 50)).toBe(0);
  });

  it("treats lotSize <= 1 as no lot constraint", () => {
    expect(roundUpToLot(37, 1)).toBe(37);
    expect(roundDownToLot(37, 1)).toBe(37);
  });

  it("is asymmetric by design — up for demand, down for caps", () => {
    expect(roundUpToLot(280, 50)).toBe(300);
    expect(roundDownToLot(280, 50)).toBe(250);
  });
});

describe("evidence gate", () => {
  const base = {
    horizonDays: 14,
    forecastUnits: 500,
    actualLast7d: 245,
    forecastUpdatedAt: daysBefore(2),
    now: NOW,
  };

  it("passes on fresh, corroborated forecasts", () => {
    const e = assessEvidence(base);
    expect(e.forecastRunRate7d).toBe(250);
    expect(e.divergence).toBeCloseTo(0.02, 3);
    expect(e.passed).toBe(true);
  });

  it("fails when the forecast is older than 14 days", () => {
    const e = assessEvidence({ ...base, forecastUpdatedAt: daysBefore(21) });
    expect(e.stale).toBe(true);
    expect(e.passed).toBe(false);
  });

  it("fails when actual sales diverge more than 30% from run-rate", () => {
    const e = assessEvidence({ ...base, actualLast7d: 400 });
    expect(e.divergence).toBeCloseTo(0.6, 3);
    expect(e.divergent).toBe(true);
    expect(e.passed).toBe(false);
  });

  it("does not fire at exactly the thresholds", () => {
    expect(assessEvidence({ ...base, forecastUpdatedAt: daysBefore(14) }).stale).toBe(false);
    expect(assessEvidence({ ...base, actualLast7d: 325 }).divergent).toBe(false);
  });
});

describe("S1-A — MODIFY, storage-capped (flagship)", () => {
  const s: PurchaseSituation = {
    recommendedQty: 800,
    onHand: 120,
    reserved: 20,
    horizonDays: 14,
    forecastUnits: 500,
    safetyStock: 50,
    actualLast7d: 245,
    forecastUpdatedAt: daysBefore(2),
    incoming: 100,
    budgetTotal: 245_000,
    budgetUsed: 45_000,
    storageCapacity: 500,
    storageUsed: 120,
    supplier: meridianEarbuds,
    now: NOW,
  };

  const r = decidePurchase(s);

  it("derives the figures from the spec", () => {
    expect(r.derived.available).toBe(100);
    expect(r.derived.demand).toBe(550);
    expect(r.derived.netRequirement).toBe(350);
    expect(r.derived.headroomStorage).toBe(280);
    expect(r.derived.headroomBudget).toBe(444);
  });

  it("modifies 800 down to 250", () => {
    expect(r.decision).toBe("MODIFY");
    expect(r.quantity).toBe(250);
  });

  it("names storage as the binding constraint", () => {
    expect(r.bindingConstraint).toBe("STORAGE");
  });

  it("is not urgent — lead time 2d fits inside 2.5d of cover", () => {
    expect(r.derived.daysToStockout).toBeCloseTo(2.545, 2);
    expect(r.urgent).toBe(false);
  });

  it("would order 800 without the storage cap — the cap is what matters", () => {
    const uncapped = decidePurchase({ ...s, storageCapacity: 5000 });
    expect(uncapped.quantity).toBe(350);
    expect(uncapped.bindingConstraint).toBe("DEMAND");
  });

  it("still modifies if the open PO is overlooked, but to a different number", () => {
    // Guards against an implementation that silently ignores `incoming`.
    const ignoringOpenPo = decidePurchase({ ...s, incoming: 0 });
    expect(ignoringOpenPo.derived.netRequirement).toBe(450);
    expect(ignoringOpenPo.quantity).toBe(350);
  });
});

describe("S1-B — REJECT, demand already covered", () => {
  const r = decidePurchase({
    recommendedQty: 800,
    onHand: 430,
    reserved: 30,
    horizonDays: 14,
    forecastUnits: 300,
    safetyStock: 30,
    actualLast7d: 142,
    forecastUpdatedAt: daysBefore(3),
    incoming: 0,
    budgetTotal: 150_000,
    budgetUsed: 0,
    storageCapacity: 900,
    storageUsed: 430,
    supplier: {
      supplierId: "sup_meridian",
      supplierName: "Meridian Distributors",
      unitPrice: 620,
      moq: 50,
      lotSize: 25,
      leadTimeDays: 4,
    },
    now: NOW,
  });

  it("computes zero net requirement", () => {
    expect(r.derived.available).toBe(400);
    expect(r.derived.demand).toBe(330);
    expect(r.derived.netRequirement).toBe(0);
  });

  it("rejects the recommendation of 800", () => {
    expect(r.decision).toBe("REJECT");
    expect(r.quantity).toBe(0);
    expect(r.bindingConstraint).toBe("DEMAND");
    expect(r.escalate).toBe(false);
  });
});

describe("S1-C — REJECT, MOQ unreachable", () => {
  const r = decidePurchase({
    recommendedQty: 500,
    onHand: 200,
    reserved: 0,
    horizonDays: 14,
    forecastUnits: 240,
    safetyStock: 20,
    actualLast7d: 115,
    forecastUpdatedAt: daysBefore(4),
    incoming: 0,
    budgetTotal: 500_000,
    budgetUsed: 0,
    storageCapacity: 300,
    storageUsed: 200,
    supplier: {
      supplierId: "sup_kavery",
      supplierName: "Kavery Wholesale",
      unitPrice: 890,
      moq: 500,
      lotSize: 10,
      leadTimeDays: 8,
    },
    now: NOW,
  });

  it("needs only 60 units but the supplier will not sell fewer than 500", () => {
    expect(r.derived.netRequirement).toBe(60);
    expect(r.derived.headroomStorage).toBe(100);
  });

  it("rejects and escalates rather than ordering an unacceptable quantity", () => {
    expect(r.decision).toBe("REJECT");
    expect(r.bindingConstraint).toBe("MOQ");
    expect(r.escalate).toBe(true);
  });
});

describe("S1-D — INVESTIGATE, evidence gate fails", () => {
  const r = decidePurchase({
    recommendedQty: 300,
    onHand: 180,
    reserved: 0,
    horizonDays: 14,
    forecastUnits: 400,
    safetyStock: 40,
    actualLast7d: 320,
    forecastUpdatedAt: daysBefore(21),
    incoming: 0,
    budgetTotal: 400_000,
    budgetUsed: 0,
    storageCapacity: 700,
    storageUsed: 180,
    supplier: {
      supplierId: "sup_meridian",
      supplierName: "Meridian Distributors",
      unitPrice: 1200,
      moq: 50,
      lotSize: 25,
      leadTimeDays: 7,
    },
    now: NOW,
  });

  it("trips both staleness and divergence", () => {
    expect(r.derived.evidence.stale).toBe(true);
    expect(r.derived.evidence.divergent).toBe(true);
    expect(r.derived.evidence.divergence).toBeCloseTo(0.6, 2);
  });

  it("investigates and proposes no quantity", () => {
    expect(r.decision).toBe("INVESTIGATE");
    expect(r.quantity).toBeNull();
    expect(r.bindingConstraint).toBe("EVIDENCE");
  });
});

describe("S1-E — ACCEPT", () => {
  const r = decidePurchase({
    recommendedQty: 400,
    onHand: 110,
    reserved: 10,
    horizonDays: 14,
    forecastUnits: 450,
    safetyStock: 50,
    actualLast7d: 232,
    forecastUpdatedAt: daysBefore(1),
    incoming: 0,
    budgetTotal: 100_000,
    budgetUsed: 0,
    storageCapacity: 800,
    storageUsed: 100,
    supplier: {
      supplierId: "sup_kavery",
      supplierName: "Kavery Wholesale",
      unitPrice: 200,
      moq: 100,
      lotSize: 50,
      leadTimeDays: 2,
    },
    now: NOW,
  });

  it("accepts when the recommendation matches the derived quantity", () => {
    expect(r.derived.netRequirement).toBe(400);
    expect(r.quantity).toBe(400);
    expect(r.decision).toBe("ACCEPT");
    expect(r.bindingConstraint).toBe("DEMAND");
  });
});

describe("S2-A — partial fulfilment", () => {
  const alternates: SupplierTerms[] = [
    {
      supplierId: "sup_northpoint",
      supplierName: "Northpoint Supply Co",
      unitPrice: 610,
      moq: 800,
      lotSize: 100,
      leadTimeDays: 5,
    },
    {
      supplierId: "sup_kavery",
      supplierName: "Kavery Wholesale",
      unitPrice: 520,
      moq: 200,
      lotSize: 50,
      leadTimeDays: 9,
    },
  ];

  const base = {
    orderedQty: 500,
    confirmedQty: 250,
    onHand: 1960,
    reserved: 60,
    horizonDays: 14,
    forecastUnits: 2350,
    safetyStock: 50,
    actualLast7d: 1210,
    forecastUpdatedAt: daysBefore(2),
    otherIncoming: 0,
    budgetTotal: 640_000,
    budgetUsed: 240_000,
    storageCapacity: 2600,
    storageUsed: 1960,
    alternates,
    now: NOW,
  };

  const r = decidePartialFulfilment(base);

  it("counts only the confirmed quantity as incoming", () => {
    expect(r.shortfall).toBe(250);
    expect(r.remainingNeed).toBe(250);
    expect(r.headroomStorage).toBe(390);
    expect(r.daysToStockout).toBeCloseTo(11.08, 1);
  });

  it("skips the faster supplier whose MOQ cannot be met", () => {
    const northpoint = r.evaluations.find(
      (e) => e.supplier.supplierId === "sup_northpoint"
    );
    expect(northpoint?.qualified).toBe(false);
    expect(northpoint?.proposedQty).toBe(300);
    expect(northpoint?.disqualifiedBecause).toContain("MOQ");
  });

  it("sources 250 units from Kavery", () => {
    expect(r.outcome).toBe("CREATE_SUPPLEMENTARY_PO");
    expect(r.chosenSupplier?.supplierId).toBe("sup_kavery");
    expect(r.quantity).toBe(250);
  });

  it("takes no action when existing cover absorbs the shortfall", () => {
    const covered = decidePartialFulfilment({ ...base, onHand: 2600 });
    expect(covered.outcome).toBe("NO_ACTION");
    expect(covered.remainingNeed).toBe(0);
  });

  it("escalates when every alternate misses the stockout window", () => {
    const slow = decidePartialFulfilment({
      ...base,
      alternates: alternates.map((a) => ({ ...a, leadTimeDays: 30 })),
    });
    expect(slow.outcome).toBe("ESCALATE");
    expect(slow.chosenSupplier).toBeNull();
  });
});