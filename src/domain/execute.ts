/**
 * Execution and the validate/rollback half of the feedback loop.
 *
 * Sequence:
 *   1. idempotency check — a repeated approval returns the original order
 *   2. price the order from live supplier terms, never from the caller
 *   3. create the PO as OPEN and debit the node budget, in one transaction
 *   4. validate against state re-read AFTER the write
 *   5. on failure, revert the PO to DRAFT and credit the budget back
 *
 * Steps 3 and 5 use array-form transactions rather than interactive ones, which
 * behave more predictably through Neon's pooler.
 *
 * The order is created BEFORE validation on purpose. Validating a hypothetical
 * would only re-run the agent's own arithmetic; validating a real row catches
 * the case where the world moved between deciding and acting.
 */

import { PoStatus, RunStatus, type PurchaseOrder } from "@prisma/client";
import { prisma } from "@/lib/db";
import { loadValidationInput } from "./state";
import {
  runValidationChecks,
  buildReinvestigationBrief,
  type ValidationOutcome,
} from "./validate";

export interface ExecuteInput {
  runId: string;
  productId: string;
  nodeId: string;
  supplierId: string;
  quantity: number;
  /** Stable per approval. A double-click must not create a second order. */
  idempotencyKey: string;
  /** Set when this order replaces a shortfall from an earlier one. */
  parentPoId?: string | null;
  /** What the agent committed to, for reconciliation check V7. */
  agentStatedQuantity: number | null;
}

export interface ExecuteResult {
  po: PurchaseOrder;
  validation: ValidationOutcome;
  /** True when validation rejected the order and it was reverted to DRAFT. */
  rolledBack: boolean;
  /** True when an existing order was returned instead of creating a new one. */
  reused: boolean;
  /** Evidence for a re-investigation run. Null when validation passed. */
  brief: string | null;
}

export async function executePurchase(
  input: ExecuteInput
): Promise<ExecuteResult> {
  const existing = await prisma.purchaseOrder.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });

  if (existing) {
    const prior = await prisma.validationResult.findFirst({
      where: { poId: existing.id },
      orderBy: { createdAt: "desc" },
    });

    return {
      po: existing,
      validation: (prior?.checks as unknown as ValidationOutcome) ?? {
        passed: existing.status === PoStatus.OPEN,
        checks: [],
        failedIds: [],
        summary: "Existing order returned; no validation record found.",
      },
      rolledBack: existing.status === PoStatus.DRAFT,
      reused: true,
      brief: null,
    };
  }

  // Price from live terms. A caller-supplied price would let a mispriced
  // decision slip past the budget check.
  const terms = await prisma.supplierTerm.findUnique({
    where: {
      supplierId_productId: {
        supplierId: input.supplierId,
        productId: input.productId,
      },
    },
  });

  // Missing terms are not thrown on. The order is created unpriced so that V8
  // can fail it explicitly and the buyer sees WHY rather than a stack trace.
  const unitPrice = terms?.unitPrice ?? 0;
  const leadTimeDays = terms?.leadTimeDays ?? 0;
  const cost = input.quantity * unitPrice;

  const expectedDate = new Date(
    Date.now() + leadTimeDays * 24 * 60 * 60 * 1000
  );

  const [po] = await prisma.$transaction([
    prisma.purchaseOrder.create({
      data: {
        productId: input.productId,
        nodeId: input.nodeId,
        supplierId: input.supplierId,
        quantity: input.quantity,
        unitPrice,
        status: PoStatus.OPEN,
        expectedDate,
        idempotencyKey: input.idempotencyKey,
        parentPoId: input.parentPoId ?? null,
      },
    }),
    prisma.nodeConstraint.update({
      where: { nodeId: input.nodeId },
      data: { budgetUsed: { increment: cost } },
    }),
  ]);

  // Read AFTER the write, so the order is checked against the world it landed in.
  const validationInput = await loadValidationInput(
    po.id,
    input.agentStatedQuantity
  );

  if (!validationInput) {
    throw new Error(`Purchase order ${po.id} vanished before validation.`);
  }

  const validation = runValidationChecks(validationInput);

  await prisma.validationResult.create({
    data: {
      runId: input.runId,
      poId: po.id,
      passed: validation.passed,
      checks: validation as unknown as object,
    },
  });

  if (validation.passed) {
    await prisma.agentRun.update({
      where: { id: input.runId },
      data: { status: RunStatus.VALIDATED, resultPoId: po.id },
    });

    return { po, validation, rolledBack: false, reused: false, brief: null };
  }

  // Rollback: DRAFT orders neither count as incoming nor consume budget.
  const [rolledBackPo] = await prisma.$transaction([
    prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { status: PoStatus.DRAFT },
    }),
    prisma.nodeConstraint.update({
      where: { nodeId: input.nodeId },
      data: { budgetUsed: { decrement: cost } },
    }),
    prisma.agentRun.update({
      where: { id: input.runId },
      data: { status: RunStatus.VALIDATION_FAILED, resultPoId: po.id },
    }),
  ]);

  const brief = buildReinvestigationBrief(validation, {
    poQuantity: po.quantity,
    supplierName: validationInput.poSupplierName,
  });

  return {
    po: rolledBackPo,
    validation,
    rolledBack: true,
    reused: false,
    brief,
  };
}

/**
 * Re-validates an existing order without creating anything. Used when a supplier
 * response changes an order after the fact, and by the UI's re-check affordance.
 */
export async function revalidatePurchaseOrder(
  runId: string,
  poId: string,
  agentStatedQuantity: number | null
): Promise<ValidationOutcome> {
  const input = await loadValidationInput(poId, agentStatedQuantity);
  if (!input) throw new Error(`Purchase order ${poId} not found.`);

  const validation = runValidationChecks(input);

  await prisma.validationResult.create({
    data: {
      runId,
      poId,
      passed: validation.passed,
      checks: validation as unknown as object,
    },
  });

  return validation;
}