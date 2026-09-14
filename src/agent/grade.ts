import {
  gradePurchaseDecision,
  gradeShortfallDecision,
  type AgentDecisionShape,
  type GradeResult,
} from "@/domain/grade";
import {
  computePurchaseTruth,
  computeShortfallTruth,
  S2A_PO_ID,
  scenarioKind,
} from "@/domain/scenarios";

/**
 * Loads live ground truth and grades an agent decision with the canonical
 * equivalence-class grader in domain/grading.ts.
 */
export async function gradeDecision(
  scenarioKey: string,
  recommendationId: string | null,
  decision: AgentDecisionShape
): Promise<GradeResult | null> {
  if (scenarioKind(scenarioKey) === "shortfall") {
    const truth = await computeShortfallTruth(S2A_PO_ID);
    if (!truth) return null;
    return gradeShortfallDecision(truth, decision);
  }

  if (!recommendationId) return null;
  const truth = await computePurchaseTruth(recommendationId);
  if (!truth) return null;
  return gradePurchaseDecision(truth, decision);
}
