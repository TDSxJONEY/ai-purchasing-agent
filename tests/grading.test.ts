import { describe, it, expect } from "vitest";
import { gradePurchaseDecision, gradeShortfallDecision } from "../src/domain/grade";

describe("equivalence-class grading", () => {
  it("treats REJECT and NO_ACTION as equivalent when demand is covered", () => {
    const result = gradePurchaseDecision(
      {
        decision: "REJECT",
        quantity: 0,
        bindingConstraint: "DEMAND",
        escalate: false,
        reason: "covered",
      },
      {
        decision: "NO_ACTION",
        quantity: 0,
        bindingConstraint: "DEMAND",
        supplierId: null,
      }
    );
    expect(result.passed).toBe(true);
    expect(result.checks.find((c) => c.field === "decision")?.ok).toBe(true);
  });

  it("does not treat REJECT and MODIFY as equivalent", () => {
    const result = gradePurchaseDecision(
      {
        decision: "REJECT",
        quantity: 0,
        bindingConstraint: "DEMAND",
        escalate: false,
        reason: "covered",
      },
      {
        decision: "MODIFY",
        quantity: 0,
        bindingConstraint: "DEMAND",
        supplierId: null,
      }
    );
    expect(result.passed).toBe(false);
  });

  it("treats constraint labels as advisory", () => {
    const result = gradePurchaseDecision(
      {
        decision: "MODIFY",
        quantity: 250,
        bindingConstraint: "STORAGE",
        escalate: false,
        reason: "storage",
      },
      {
        decision: "MODIFY",
        quantity: 250,
        bindingConstraint: "MOQ",
        supplierId: "sup_meridian",
      }
    );
    expect(result.passed).toBe(true);
    expect(result.checks.find((c) => c.field === "constraint")?.weight).toBe("secondary");
    expect(result.checks.find((c) => c.field === "constraint")?.ok).toBe(false);
  });

  it("grades S2 supplier as primary", () => {
    const result = gradeShortfallDecision(
      {
        outcome: "CREATE_SUPPLEMENTARY_PO",
        quantity: 250,
        chosenSupplierId: "sup_kavery",
        reason: "kavery",
      },
      {
        decision: "CREATE_SUPPLEMENTARY_PO",
        quantity: 250,
        bindingConstraint: "LEAD_TIME",
        supplierId: "sup_northpoint",
      }
    );
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.field === "supplier")?.weight).toBe("primary");
  });
});
