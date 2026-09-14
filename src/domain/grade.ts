/**
 * Canonical grading lives in grading.ts. This file is the stable import path
 * used by scenario runtime, the CLI and evaluation tests.
 */
export {
  gradePurchaseDecision,
  gradeShortfallDecision,
  type OutcomeLabel,
  type GradedCheck,
  type GradeResult,
  type PurchaseTruth,
  type ShortfallTruth,
  type AgentDecisionShape,
} from "./grading";
