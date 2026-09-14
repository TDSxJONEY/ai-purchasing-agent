/**
 * Deterministic reference implementation of docs/decision-spec.md.
 *
 * IMPORTANT: this module is NOT exposed to the agent as a tool, and the agent is
 * never shown these formulas. The LLM receives raw operational data and must
 * reason its way to a decision on its own. This file exists to provide:
 *
 *   1. ground truth for the evaluation suite (tests/rules.test.ts)
 *   2. the shared primitives used by the independent validator
 *
 * If the agent could call this, validation would be circular and the feedback
 * loop would be dead code.
 *
 * Pure functions only. No I/O, no Prisma, no Date.now() unless injected.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type Decision = "ACCEPT" | "MODIFY" | "REJECT" | "INVESTIGATE";

export type BindingConstraint =
  | "DEMAND"
  | "STORAGE"
  | "BUDGET"
  | "MOQ"
  | "EVIDENCE"
  | "LEAD_TIME"
  | "NONE";

export interface SupplierTerms {
  supplierId: string;
  supplierName: string;
  unitPrice: number;
  moq: number;
  lotSize: number;
  leadTimeDays: number;
}

export interface PurchaseSituation {
  recommendedQty: number;
  onHand: number;
  reserved: number;
  horizonDays: number;
  forecastUnits: number;
  safetyStock: number;
  actualLast7d: number;
  forecastUpdatedAt: Date;
  /** Σ quantity of open POs arriving within the horizon. */
  incoming: number;
  budgetTotal: number;
  budgetUsed: number;
  storageCapacity: number;
  storageUsed: number;
  supplier: SupplierTerms;
  /** Injected for determinism in tests. Defaults to the real clock. */
  now?: Date;
}

export interface EvidenceAssessment {
  stale: boolean;
  divergent: boolean;
  forecastAgeDays: number;
  forecastRunRate7d: number;
  divergence: number;
  passed: boolean;
}

export interface DerivedFigures {
  available: number;
  demand: number;
  incoming: number;
  netRequirement: number;
  headroomStorage: number;
  headroomBudget: number;
  dailyDemand: number;
  daysToStockout: number;
  evidence: EvidenceAssessment;
}

export interface PurchaseDecisionResult {
  decision: Decision;
  quantity: number | null;
  bindingConstraint: BindingConstraint;
  urgent: boolean;
  escalate: boolean;
  reason: string;
  derived: DerivedFigures;
}

// ─── Thresholds (spec §2) ───────────────────────────────────────────────────

export const FORECAST_STALE_DAYS = 14;
export const FORECAST_DIVERGENCE_LIMIT = 0.3;
/** Spec §7 V6: resulting position may exceed demand by at most this fraction. */
export const OVERBUY_TOLERANCE = 0.2;

// ─── Primitives ─────────────────────────────────────────────────────────────

/**
 * Round UP to a lot multiple. Used when meeting demand: a partial lot cannot be
 * ordered, so we take the next orderable quantity at or above the requirement.
 */
export function roundUpToLot(n: number, lotSize: number): number {
  if (lotSize <= 1) return Math.max(0, Math.ceil(n));
  return Math.ceil(Math.max(0, n) / lotSize) * lotSize;
}

/**
 * Round DOWN to a lot multiple. Used when capping: exceeding a hard constraint
 * is not permitted, so we take the largest orderable quantity at or below it.
 *
 * The asymmetry with roundUpToLot is deliberate (spec §3).
 */
export function roundDownToLot(n: number, lotSize: number): number {
  if (lotSize <= 1) return Math.max(0, Math.floor(n));
  return Math.floor(Math.max(0, n) / lotSize) * lotSize;
}

// ─── Evidence gate (spec §2) ────────────────────────────────────────────────

export function assessEvidence(
  s: Pick<
    PurchaseSituation,
    "horizonDays" | "forecastUnits" | "actualLast7d" | "forecastUpdatedAt" | "now"
  >
): EvidenceAssessment {
  const now = s.now ?? new Date();
  const ageMs = now.getTime() - s.forecastUpdatedAt.getTime();
  const forecastAgeDays = ageMs / (24 * 60 * 60 * 1000);

  const forecastRunRate7d =
    s.horizonDays > 0 ? s.forecastUnits * (7 / s.horizonDays) : 0;

  const divergence =
    forecastRunRate7d > 0
      ? Math.abs(s.actualLast7d - forecastRunRate7d) / forecastRunRate7d
      : 0;

  const stale = forecastAgeDays > FORECAST_STALE_DAYS;
  const divergent = divergence > FORECAST_DIVERGENCE_LIMIT;

  return {
    stale,
    divergent,
    forecastAgeDays,
    forecastRunRate7d,
    divergence,
    passed: !stale && !divergent,
  };
}

// ─── Derived figures ────────────────────────────────────────────────────────

export function derive(s: PurchaseSituation): DerivedFigures {
  const available = s.onHand - s.reserved;
  const demand = s.forecastUnits + s.safetyStock;
  const netRequirement = Math.max(0, demand - available - s.incoming);

  // `incoming` is subtracted from storage headroom because stock already on
  // order will occupy the same shelf space when it lands.
  const headroomStorage = Math.max(
    0,
    s.storageCapacity - s.storageUsed - s.incoming
  );

  const headroomBudget =
    s.supplier.unitPrice > 0
      ? Math.floor(
          Math.max(0, s.budgetTotal - s.budgetUsed) / s.supplier.unitPrice
        )
      : 0;

  const dailyDemand = s.horizonDays > 0 ? demand / s.horizonDays : 0;
  const daysToStockout =
    dailyDemand > 0 ? available / dailyDemand : Number.POSITIVE_INFINITY;

  return {
    available,
    demand,
    incoming: s.incoming,
    netRequirement,
    headroomStorage,
    headroomBudget,
    dailyDemand,
    daysToStockout,
    evidence: assessEvidence(s),
  };
}

// ─── Main decision (spec §3 and §4) ─────────────────────────────────────────

export function decidePurchase(s: PurchaseSituation): PurchaseDecisionResult {
  const derived = derive(s);
  const { moq, lotSize, leadTimeDays } = s.supplier;

  const urgent = leadTimeDays > derived.daysToStockout;

  // §2 — evidence gate runs first and short-circuits the arithmetic entirely.
  if (!derived.evidence.passed) {
    const causes: string[] = [];
    if (derived.evidence.stale) {
      causes.push(
        `forecast is ${derived.evidence.forecastAgeDays.toFixed(0)} days old ` +
          `(limit ${FORECAST_STALE_DAYS})`
      );
    }
    if (derived.evidence.divergent) {
      causes.push(
        `actual 7-day sales of ${s.actualLast7d} diverge ` +
          `${(derived.evidence.divergence * 100).toFixed(0)}% from the forecast ` +
          `run-rate of ${derived.evidence.forecastRunRate7d.toFixed(0)}`
      );
    }
    return {
      decision: "INVESTIGATE",
      quantity: null,
      bindingConstraint: "EVIDENCE",
      urgent,
      escalate: false,
      reason: `Demand evidence is not reliable enough to commit spend: ${causes.join("; ")}.`,
      derived,
    };
  }

  // §3 — demand already covered.
  if (derived.netRequirement === 0) {
    return {
      decision: "REJECT",
      quantity: 0,
      bindingConstraint: "DEMAND",
      urgent,
      escalate: false,
      reason:
        `Available stock (${derived.available}) plus incoming (${derived.incoming}) ` +
        `already covers demand of ${derived.demand} over ${s.horizonDays} days. ` +
        `No purchase required.`,
      derived,
    };
  }

  // §3 — round up to a lot, then lift to MOQ if needed.
  const demandDriven = roundUpToLot(derived.netRequirement, lotSize);
  const moqLifted = demandDriven < moq ? moq : demandDriven;
  const moqRaisedIt = moqLifted > demandDriven;

  // §3 — cap by the binding constraint, rounding DOWN.
  const cap = Math.min(derived.headroomStorage, derived.headroomBudget);
  const capBinds = cap < moqLifted;
  const quantity = roundDownToLot(Math.min(moqLifted, cap), lotSize);

  let bindingConstraint: BindingConstraint;
  if (capBinds) {
    bindingConstraint =
      derived.headroomStorage <= derived.headroomBudget ? "STORAGE" : "BUDGET";
  } else if (moqRaisedIt) {
    bindingConstraint = "MOQ";
  } else {
    bindingConstraint = "DEMAND";
  }

  // §3 — MOQ unreachable inside the constraints.
  if (quantity < moq) {
    return {
      decision: "REJECT",
      quantity: 0,
      bindingConstraint: "MOQ",
      urgent,
      escalate: true,
      reason:
        `Supplier MOQ of ${moq} cannot be satisfied: storage headroom is ` +
        `${derived.headroomStorage} and budget headroom is ${derived.headroomBudget}, ` +
        `allowing at most ${quantity} units. Escalating rather than ordering a ` +
        `quantity the supplier will not accept.`,
      derived,
    };
  }

  // §4 — map to a decision.
  const matchesRecommendation = quantity === s.recommendedQty;

  const reason = matchesRecommendation
    ? `Net requirement of ${derived.netRequirement} units resolves to ${quantity} ` +
      `after lot sizing, which matches the system recommendation. Storage headroom ` +
      `${derived.headroomStorage} and budget headroom ${derived.headroomBudget} both allow it.`
    : `System recommended ${s.recommendedQty} but the correct quantity is ${quantity}. ` +
      `Net requirement is ${derived.netRequirement} ` +
      `(demand ${derived.demand} less available ${derived.available} less incoming ${derived.incoming}); ` +
      `binding constraint is ${bindingConstraint.toLowerCase()} ` +
      `(storage headroom ${derived.headroomStorage}, budget headroom ${derived.headroomBudget}).`;

  return {
    decision: matchesRecommendation ? "ACCEPT" : "MODIFY",
    quantity,
    bindingConstraint,
    urgent,
    escalate: false,
    reason,
    derived,
  };
}

// ─── Partial fulfilment (spec §6, Scenario 2) ───────────────────────────────

export type PartialOutcome =
  | "NO_ACTION"
  | "CREATE_SUPPLEMENTARY_PO"
  | "ESCALATE";

export interface PartialFulfilmentSituation {
  orderedQty: number;
  confirmedQty: number;
  onHand: number;
  reserved: number;
  horizonDays: number;
  forecastUnits: number;
  safetyStock: number;
  actualLast7d: number;
  forecastUpdatedAt: Date;
  /** Incoming from OTHER open POs, excluding the partially fulfilled one. */
  otherIncoming: number;
  budgetTotal: number;
  budgetUsed: number;
  storageCapacity: number;
  storageUsed: number;
  /** Candidate suppliers excluding the one that failed to fulfil. */
  alternates: SupplierTerms[];
  now?: Date;
}

export interface SupplierEvaluation {
  supplier: SupplierTerms;
  qualified: boolean;
  proposedQty: number;
  headroomBudget: number;
  disqualifiedBecause: string | null;
}

export interface PartialFulfilmentResult {
  outcome: PartialOutcome;
  shortfall: number;
  remainingNeed: number;
  daysToStockout: number;
  headroomStorage: number;
  chosenSupplier: SupplierTerms | null;
  quantity: number;
  evaluations: SupplierEvaluation[];
  reason: string;
}

export function decidePartialFulfilment(
  s: PartialFulfilmentSituation
): PartialFulfilmentResult {
  const shortfall = Math.max(0, s.orderedQty - s.confirmedQty);
  const available = s.onHand - s.reserved;
  const demand = s.forecastUnits + s.safetyStock;

  // Only the CONFIRMED quantity counts as incoming. This is the crux of the
  // scenario: treating the original 500 as incoming would hide the gap.
  const incoming = s.otherIncoming + s.confirmedQty;
  const remainingNeed = Math.max(0, demand - available - incoming);

  const dailyDemand = s.horizonDays > 0 ? demand / s.horizonDays : 0;
  const daysToStockout =
    dailyDemand > 0 ? available / dailyDemand : Number.POSITIVE_INFINITY;

  const headroomStorage = Math.max(
    0,
    s.storageCapacity - s.storageUsed - incoming
  );

  if (remainingNeed === 0) {
    return {
      outcome: "NO_ACTION",
      shortfall,
      remainingNeed: 0,
      daysToStockout,
      headroomStorage,
      chosenSupplier: null,
      quantity: 0,
      evaluations: [],
      reason:
        `Supplier short by ${shortfall} units, but available stock (${available}) ` +
        `plus confirmed incoming (${incoming}) still covers demand of ${demand}. ` +
        `No replacement sourcing required.`,
    };
  }

  // Ascending by lead time: closing the gap before stockout matters more than
  // unit price here.
  const ordered = [...s.alternates].sort(
    (a, b) => a.leadTimeDays - b.leadTimeDays
  );

  const evaluations: SupplierEvaluation[] = [];
  let chosen: SupplierEvaluation | null = null;

  for (const alt of ordered) {
    const headroomBudget =
      alt.unitPrice > 0
        ? Math.floor(Math.max(0, s.budgetTotal - s.budgetUsed) / alt.unitPrice)
        : 0;

    const demandDriven = roundUpToLot(remainingNeed, alt.lotSize);
    const moqLifted = demandDriven < alt.moq ? alt.moq : demandDriven;
    const proposedQty = roundDownToLot(
      Math.min(moqLifted, headroomStorage, headroomBudget),
      alt.lotSize
    );

    let disqualifiedBecause: string | null = null;
    if (proposedQty < alt.moq) {
      disqualifiedBecause =
        `MOQ ${alt.moq} unreachable — storage headroom ${headroomStorage}, ` +
        `budget headroom ${headroomBudget} allow only ${proposedQty}`;
    } else if (alt.leadTimeDays > daysToStockout) {
      disqualifiedBecause =
        `lead time ${alt.leadTimeDays}d exceeds ${daysToStockout.toFixed(1)}d to stockout`;
    }

    const evaluation: SupplierEvaluation = {
      supplier: alt,
      qualified: disqualifiedBecause === null,
      proposedQty,
      headroomBudget,
      disqualifiedBecause,
    };
    evaluations.push(evaluation);

    if (evaluation.qualified && chosen === null) {
      chosen = evaluation;
    }
  }

  if (chosen === null) {
    return {
      outcome: "ESCALATE",
      shortfall,
      remainingNeed,
      daysToStockout,
      headroomStorage,
      chosenSupplier: null,
      quantity: 0,
      evaluations,
      reason:
        `Shortfall of ${shortfall} leaves ${remainingNeed} units uncovered and no ` +
        `alternate supplier can close it in time. ` +
        evaluations
          .map((e) => `${e.supplier.supplierName}: ${e.disqualifiedBecause}`)
          .join("; ") +
        `. Escalating to a human buyer.`,
    };
  }

  return {
    outcome: "CREATE_SUPPLEMENTARY_PO",
    shortfall,
    remainingNeed,
    daysToStockout,
    headroomStorage,
    chosenSupplier: chosen.supplier,
    quantity: chosen.proposedQty,
    evaluations,
    reason:
      `Supplier confirmed only ${s.confirmedQty} of ${s.orderedQty}, leaving ` +
      `${remainingNeed} units uncovered against demand of ${demand}. ` +
      `${chosen.supplier.supplierName} can deliver ${chosen.proposedQty} units in ` +
      `${chosen.supplier.leadTimeDays} days, inside the ${daysToStockout.toFixed(1)} ` +
      `days of cover remaining.`,
  };
}