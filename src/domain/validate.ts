/**
 * Independent post-execution validator — docs/decision-spec.md §7.
 *
 * This module deliberately does NOT import decidePurchase(). It re-derives what
 * it needs from live state and checks the purchase order that actually exists in
 * the database. If it reused the decision engine, validation would be circular:
 * the agent's answer would be graded against the same computation that produced
 * it, every check would pass, and the failure branch would be unreachable code.
 *
 * Two checks — V4 and V5 — recompute headroom from state read AT VALIDATION TIME
 * rather than from the snapshot the agent saw during investigation. They can
 * therefore fail even when the agent reasoned perfectly, because budget or
 * storage may have been consumed in between. That is the intended source of
 * divergence and the reason the feedback loop is live rather than decorative.
 *
 * runValidationChecks() is pure. The database-reading wrapper lives in
 * validatePurchaseOrder() (see execute.ts round).
 */

import { OVERBUY_TOLERANCE } from "./rules";

export type CheckId = "V1" | "V2" | "V3" | "V4" | "V5" | "V6" | "V7" | "V8";

export interface ValidationCheck {
  id: CheckId;
  label: string;
  passed: boolean;
  detail: string;
  /** True when the check depends on state re-read at validation time. */
  stateSensitive: boolean;
}

export interface ValidationInput {
  // The purchase order under test
  poQuantity: number;
  poUnitPrice: number;
  poSupplierId: string;
  poSupplierName: string;

  // What the agent said it was doing
  agentStatedQuantity: number | null;

  // Supplier terms, read live
  supplierMoq: number;
  supplierLotSize: number;
  /** False when no SupplierTerm row links this supplier to this product. */
  supplierSuppliesProduct: boolean;

  // Operational state, read live
  onHand: number;
  reserved: number;
  forecastUnits: number;
  safetyStock: number;
  /** Σ open/partial PO quantity for this product+node, EXCLUDING the PO under test. */
  otherIncoming: number;

  storageCapacity: number;
  storageUsed: number;
  budgetTotal: number;
  /** budgetUsed with this PO's own cost already subtracted out. */
  budgetUsedExcludingThisPo: number;
}

export interface ValidationOutcome {
  passed: boolean;
  checks: ValidationCheck[];
  failedIds: CheckId[];
  /** One-line summary suitable for the UI and for feeding a re-investigation. */
  summary: string;
}

export function runValidationChecks(input: ValidationInput): ValidationOutcome {
  const {
    poQuantity,
    poUnitPrice,
    poSupplierName,
    agentStatedQuantity,
    supplierMoq,
    supplierLotSize,
    supplierSuppliesProduct,
    onHand,
    reserved,
    forecastUnits,
    safetyStock,
    otherIncoming,
    storageCapacity,
    storageUsed,
    budgetTotal,
    budgetUsedExcludingThisPo,
  } = input;

  const available = onHand - reserved;
  const demand = forecastUnits + safetyStock;

  // Recomputed now, not taken from the agent's snapshot.
  const headroomStorage = Math.max(
    0,
    storageCapacity - storageUsed - otherIncoming
  );
  const budgetRemaining = Math.max(0, budgetTotal - budgetUsedExcludingThisPo);
  const orderCost = poQuantity * poUnitPrice;

  const resultingPosition = available + otherIncoming + poQuantity;
  const overbuyCeiling = Math.floor(demand * (1 + OVERBUY_TOLERANCE));

  const checks: ValidationCheck[] = [
    {
      id: "V1",
      label: "Quantity is positive",
      passed: poQuantity > 0,
      detail: `Ordered quantity is ${poQuantity}.`,
      stateSensitive: false,
    },
    {
      id: "V2",
      label: "Meets supplier minimum order quantity",
      passed: poQuantity >= supplierMoq,
      detail: `Ordered ${poQuantity} against a MOQ of ${supplierMoq} for ${poSupplierName}.`,
      stateSensitive: false,
    },
    {
      id: "V3",
      label: "Quantity is a whole multiple of the lot size",
      passed: supplierLotSize <= 1 || poQuantity % supplierLotSize === 0,
      detail:
        supplierLotSize <= 1
          ? `${poSupplierName} imposes no lot size.`
          : `${poQuantity} against a lot size of ${supplierLotSize} leaves a remainder of ${
              poQuantity % supplierLotSize
            }.`,
      stateSensitive: false,
    },
    {
      id: "V4",
      label: "Fits within current storage headroom",
      passed: poQuantity <= headroomStorage,
      detail:
        `Storage headroom recomputed now is ${headroomStorage} ` +
        `(capacity ${storageCapacity} less used ${storageUsed} less other incoming ${otherIncoming}); ` +
        `order is ${poQuantity}.`,
      stateSensitive: true,
    },
    {
      id: "V5",
      label: "Fits within current remaining budget",
      passed: orderCost <= budgetRemaining,
      detail:
        `Order cost is ${orderCost} (${poQuantity} at ${poUnitPrice}); ` +
        `budget remaining recomputed now is ${budgetRemaining} ` +
        `(total ${budgetTotal} less other committed ${budgetUsedExcludingThisPo}).`,
      stateSensitive: true,
    },
    {
      id: "V6",
      label: `Resulting position does not overshoot demand by more than ${
        OVERBUY_TOLERANCE * 100
      }%`,
      passed: resultingPosition <= overbuyCeiling,
      detail:
        `Resulting position is ${resultingPosition} ` +
        `(available ${available} plus other incoming ${otherIncoming} plus order ${poQuantity}) ` +
        `against demand of ${demand}, ceiling ${overbuyCeiling}.`,
      stateSensitive: true,
    },
    {
      id: "V7",
      label: "Purchase order matches the quantity the agent decided on",
      passed: agentStatedQuantity !== null && poQuantity === agentStatedQuantity,
      detail:
        agentStatedQuantity === null
          ? "The agent did not state a quantity, so the created order cannot be reconciled against it."
          : `Agent decided ${agentStatedQuantity}; order was created for ${poQuantity}.`,
      stateSensitive: false,
    },
    {
      id: "V8",
      label: "Supplier actually supplies this product",
      passed: supplierSuppliesProduct,
      detail: supplierSuppliesProduct
        ? `${poSupplierName} has agreed terms for this product.`
        : `${poSupplierName} has no terms on file for this product.`,
      stateSensitive: false,
    },
  ];

  const failed = checks.filter((c) => !c.passed);
  const failedIds = failed.map((c) => c.id);

  const summary =
    failed.length === 0
      ? `All ${checks.length} checks passed against live state.`
      : `${failed.length} of ${checks.length} checks failed: ${failed
          .map((c) => `${c.id} (${c.label.toLowerCase()})`)
          .join(", ")}.`;

  return { passed: failed.length === 0, checks, failedIds, summary };
}

/**
 * Turns a failed validation into evidence a re-investigation run can consume.
 * The re-investigation is told WHAT failed and by how much, not what to do about
 * it — deciding that is the agent's job on the second pass.
 */
export function buildReinvestigationBrief(
  outcome: ValidationOutcome,
  context: { poQuantity: number; supplierName: string }
): string {
  const failed = outcome.checks.filter((c) => !c.passed);

  const lines = failed.map((c) => `- ${c.id} ${c.label}: ${c.detail}`);

  const drifted = failed.some((c) => c.stateSensitive);

  return [
    `A purchase order for ${context.poQuantity} units from ${context.supplierName} ` +
      `was created and then rejected by validation.`,
    ``,
    `Failed checks:`,
    ...lines,
    ``,
    drifted
      ? `At least one failure is state-sensitive: operational state changed between ` +
        `investigation and execution. Re-read the current figures before deciding again — ` +
        `do not reuse the earlier snapshot.`
      : `The failures are structural rather than timing-related. The proposed order ` +
        `violated a fixed supplier or ordering rule.`,
  ].join("\n");
}