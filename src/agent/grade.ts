import { prisma } from "@/lib/db";
import {
  decidePartialFulfilment,
  decidePurchase,
  type SupplierTerms,
} from "@/domain/rules";
import { loadSituation } from "@/domain/state";

export interface Grade {
  field: string;
  expected: string;
  actual: string;
  ok: boolean;
}

export async function gradePurchase(
  recommendationId: string,
  decision: {
    decision: string;
    quantity: number | null;
    bindingConstraint: string;
  }
): Promise<{ grades: Grade[]; reference: string } | null> {
  const s = await loadSituation(recommendationId);
  if (!s) return null;

  const term = await prisma.supplierTerm.findFirst({
    where: { productId: s.productId },
    include: { supplier: true },
    orderBy: { leadTimeDays: "asc" },
  });
  if (!term) return null;

  const supplier: SupplierTerms = {
    supplierId: term.supplierId,
    supplierName: term.supplier.name,
    unitPrice: term.unitPrice,
    moq: term.moq,
    lotSize: term.lotSize,
    leadTimeDays: term.leadTimeDays,
  };

  const truth = decidePurchase({
    recommendedQty: s.recommendedQty,
    onHand: s.onHand,
    reserved: s.reserved,
    horizonDays: s.horizonDays,
    forecastUnits: s.forecastUnits,
    safetyStock: s.safetyStock,
    actualLast7d: s.actualLast7d,
    forecastUpdatedAt: s.forecastUpdatedAt,
    incoming: s.incoming,
    budgetTotal: s.budgetTotal,
    budgetUsed: s.budgetUsed,
    storageCapacity: s.storageCapacity,
    storageUsed: s.storageUsed,
    supplier,
  });

  return {
    grades: [
      {
        field: "decision",
        expected: truth.decision,
        actual: decision.decision,
        ok: truth.decision === decision.decision,
      },
      {
        field: "quantity",
        expected: String(truth.quantity ?? 0),
        actual: String(decision.quantity ?? 0),
        ok: (truth.quantity ?? 0) === (decision.quantity ?? 0),
      },
      {
        field: "constraint",
        expected: truth.bindingConstraint,
        actual: decision.bindingConstraint,
        ok: truth.bindingConstraint === decision.bindingConstraint,
      },
    ],
    reference: truth.reason,
  };
}

export async function gradeShortfall(decision: {
  decision: string;
  quantity: number | null;
  supplierId: string | null;
}): Promise<{ grades: Grade[]; reference: string } | null> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: "po_s2a_partial" },
  });
  if (!po) return null;

  const [inv, forecast, constraint, terms] = await Promise.all([
    prisma.inventory.findUnique({
      where: {
        productId_nodeId: { productId: po.productId, nodeId: po.nodeId },
      },
    }),
    prisma.demandForecast.findUnique({
      where: {
        productId_nodeId: { productId: po.productId, nodeId: po.nodeId },
      },
    }),
    prisma.nodeConstraint.findUnique({ where: { nodeId: po.nodeId } }),
    prisma.supplierTerm.findMany({
      where: { productId: po.productId, supplierId: { not: po.supplierId } },
      include: { supplier: true },
    }),
  ]);

  if (!inv || !forecast || !constraint) return null;

  const truth = decidePartialFulfilment({
    orderedQty: po.quantity,
    confirmedQty: po.confirmedQty ?? 0,
    onHand: inv.onHand,
    reserved: inv.reserved,
    horizonDays: forecast.horizonDays,
    forecastUnits: forecast.forecastUnits,
    safetyStock: forecast.safetyStock,
    actualLast7d: forecast.actualLast7d,
    forecastUpdatedAt: forecast.updatedAt,
    otherIncoming: 0,
    budgetTotal: constraint.budgetTotal,
    budgetUsed: constraint.budgetUsed,
    storageCapacity: constraint.storageCapacity,
    storageUsed: constraint.storageUsed,
    alternates: terms.map((t) => ({
      supplierId: t.supplierId,
      supplierName: t.supplier.name,
      unitPrice: t.unitPrice,
      moq: t.moq,
      lotSize: t.lotSize,
      leadTimeDays: t.leadTimeDays,
    })),
  });

  return {
    grades: [
      {
        field: "outcome",
        expected: truth.outcome,
        actual: decision.decision,
        ok: truth.outcome === decision.decision,
      },
      {
        field: "quantity",
        expected: String(truth.quantity),
        actual: String(decision.quantity ?? 0),
        ok: truth.quantity === (decision.quantity ?? 0),
      },
      {
        field: "supplier",
        expected: truth.chosenSupplier?.supplierId ?? "(none)",
        actual: decision.supplierId ?? "(none)",
        ok: (truth.chosenSupplier?.supplierId ?? null) === decision.supplierId,
      },
    ],
    reference: truth.reason,
  };
}

export async function gradeDecision(
  scenarioKey: string,
  recommendationId: string | null,
  decision: {
    decision: string;
    quantity: number | null;
    bindingConstraint: string;
    supplierId: string | null;
  }
) {
  if (scenarioKey === "S2-A") return gradeShortfall(decision);
  if (!recommendationId) return null;
  return gradePurchase(recommendationId, decision);
}
