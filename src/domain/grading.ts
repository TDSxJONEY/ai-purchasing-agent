/**
 * Grades an agent decision against the deterministic rules engine.
 *
 * Shared by the CLI driver, the automated evaluation suite and the evaluation
 * page, so all three report identical numbers. A single implementation is the
 * point: an eval that disagrees with the harness is worse than no eval.
 *
 * TWO DESIGN CHOICES WORTH DEFENDING
 *
 * 1. Equivalence classes, not string equality.
 *    "Demand is already covered, buy nothing" is REJECT in the rules engine. An
 *    agent that says NO_ACTION has reached the same operational outcome by a
 *    different label. Grading that as a failure measures vocabulary compliance,
 *    not decision quality. The classes below are narrow and explicit: each one
 *    names outcomes that produce the SAME action in the world. REJECT and
 *    MODIFY are never equivalent, because one buys and one does not.
 *
 * 2. Primary and secondary checks.
 *    The action (what happens) and the quantity (how much) are primary — those
 *    are the decision. The binding-constraint label is secondary, because more
 *    than one label can be honestly defended for the same situation: when a
 *    supplier minimum cannot be met because storage is tight, MOQ and STORAGE
 *    are both true statements about the cause. It is still reported, because a
 *    consistent wrong label is a signal, but it does not sink a run that acted
 *    correctly.
 *
 * The `urgent` flag is recorded but not graded at all. It is a judgement call on
 * a continuous margin, and a marginally cautious agent is not a wrong one.
 */

import type { Decision, BindingConstraint } from "./rules";

export type OutcomeLabel =
  | Decision
  | "CREATE_SUPPLEMENTARY_PO"
  | "NO_ACTION"
  | "ESCALATE";

export interface GradedCheck {
  field: string;
  expected: string;
  actual: string;
  ok: boolean;
  weight: "primary" | "secondary";
  note?: string;
}

export interface GradeResult {
  checks: GradedCheck[];
  primaryPassed: number;
  primaryTotal: number;
  passed: boolean;
  reference: string;
}

/**
 * Outcomes that produce the same action in the world.
 *
 * Read as: if the rules engine expected the key, any value in the set is an
 * acceptable label for it.
 */
const EQUIVALENT: Record<string, string[]> = {
  // Buy nothing because demand is already covered.
  REJECT_COVERED: ["REJECT", "NO_ACTION"],
  // Buy nothing because no orderable quantity exists; a human should pick it up.
  REJECT_BLOCKED: ["REJECT", "ESCALATE"],
  // Existing cover absorbs a supplier shortfall.
  NO_ACTION: ["NO_ACTION", "REJECT"],
  // Source the gap elsewhere.
  CREATE_SUPPLEMENTARY_PO: ["CREATE_SUPPLEMENTARY_PO"],
  // No supplier can close the gap in time.
  ESCALATE: ["ESCALATE"],
  ACCEPT: ["ACCEPT"],
  MODIFY: ["MODIFY"],
  INVESTIGATE: ["INVESTIGATE"],
};

function acceptedLabels(
  expected: string,
  opts: { escalate?: boolean } = {}
): string[] {
  if (expected === "REJECT") {
    return opts.escalate
      ? EQUIVALENT.REJECT_BLOCKED
      : EQUIVALENT.REJECT_COVERED;
  }
  return EQUIVALENT[expected] ?? [expected];
}

export interface PurchaseTruth {
  decision: Decision;
  quantity: number | null;
  bindingConstraint: BindingConstraint;
  escalate: boolean;
  reason: string;
}

export interface AgentDecisionShape {
  decision: string;
  quantity: number | null;
  bindingConstraint: string;
  supplierId: string | null;
}

export function gradePurchaseDecision(
  truth: PurchaseTruth,
  actual: AgentDecisionShape
): GradeResult {
  const accepted = acceptedLabels(truth.decision, { escalate: truth.escalate });
  const decisionOk = accepted.includes(actual.decision);

  const expectedQty = truth.quantity ?? 0;
  const actualQty = actual.quantity ?? 0;

  const checks: GradedCheck[] = [
    {
      field: "decision",
      expected: truth.decision,
      actual: actual.decision,
      ok: decisionOk,
      weight: "primary",
      note:
        decisionOk && actual.decision !== truth.decision
          ? `accepted as equivalent to ${truth.decision}`
          : undefined,
    },
    {
      field: "quantity",
      expected: String(expectedQty),
      actual: String(actualQty),
      ok: expectedQty === actualQty,
      weight: "primary",
    },
    {
      field: "constraint",
      expected: truth.bindingConstraint,
      actual: actual.bindingConstraint,
      ok: truth.bindingConstraint === actual.bindingConstraint,
      weight: "secondary",
    },
  ];

  return summarise(checks, truth.reason);
}

export interface ShortfallTruth {
  outcome: "NO_ACTION" | "CREATE_SUPPLEMENTARY_PO" | "ESCALATE";
  quantity: number;
  chosenSupplierId: string | null;
  reason: string;
}

export function gradeShortfallDecision(
  truth: ShortfallTruth,
  actual: AgentDecisionShape
): GradeResult {
  const accepted = acceptedLabels(truth.outcome);
  const decisionOk = accepted.includes(actual.decision);

  const checks: GradedCheck[] = [
    {
      field: "outcome",
      expected: truth.outcome,
      actual: actual.decision,
      ok: decisionOk,
      weight: "primary",
      note:
        decisionOk && actual.decision !== truth.outcome
          ? `accepted as equivalent to ${truth.outcome}`
          : undefined,
    },
    {
      field: "quantity",
      expected: String(truth.quantity),
      actual: String(actual.quantity ?? 0),
      ok: truth.quantity === (actual.quantity ?? 0),
      weight: "primary",
    },
    {
      field: "supplier",
      expected: truth.chosenSupplierId ?? "(none)",
      actual: actual.supplierId ?? "(none)",
      // Sourcing from the supplier that just failed is a real error, not a
      // labelling nuance, so this is primary.
      ok: (truth.chosenSupplierId ?? null) === actual.supplierId,
      weight: "primary",
    },
  ];

  return summarise(checks, truth.reason);
}

function summarise(checks: GradedCheck[], reference: string): GradeResult {
  const primary = checks.filter((c) => c.weight === "primary");
  const primaryPassed = primary.filter((c) => c.ok).length;

  return {
    checks,
    primaryPassed,
    primaryTotal: primary.length,
    passed: primaryPassed === primary.length,
    reference,
  };
}