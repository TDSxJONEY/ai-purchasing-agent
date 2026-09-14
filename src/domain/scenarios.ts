/**
 * Scenario catalog.
 *
 * One place that knows how to turn a scenario key into (a) the situation
 * description handed to the agent and (b) the ground truth from the
 * deterministic rules engine. The CLI, the API routes and the evaluation suite
 * all go through here, so a scenario cannot mean one thing in the terminal and
 * something else in the browser.
 */

import { prisma } from "@/lib/db";
import {
  framePurchaseReview,
  frameSupplierShortfall,
} from "@/agent/prompt";
import {
  decidePurchase,
  decidePartialFulfilment,
  type SupplierTerms,
} from "@/domain/rules";
import type { PurchaseTruth, ShortfallTruth } from "@/domain/grade";
import { loadSituation, computeIncoming } from "@/domain/state";
import {
  SCENARIO_KEYS,
  SCENARIO_MAP,
  type ScenarioKind as CatalogKind,
} from "@/lib/scenarios";

export const REVIEW_SCENARIOS = ["S1-A", "S1-B", "S1-C", "S1-D", "S1-E"] as const;
export const SHORTFALL_SCENARIOS = ["S2-A"] as const;
export const ALL_SCENARIOS = [...SCENARIO_KEYS];

/** The purchase order the Scenario 2 demo operates on. */
export const S2A_PO_ID = SCENARIO_MAP["S2-A"].triggerPoId ?? "po_s2a_partial";

export type ScenarioKind = CatalogKind;

export interface ScenarioSetup {
  scenarioKey: string;
  kind: ScenarioKind;
  userMessage: string;
  recommendationId: string | null;
  triggerPoId: string | null;
  title: string;
  subtitle: string;
}

export function scenarioKind(scenarioKey: string): ScenarioKind {
  return SCENARIO_MAP[scenarioKey]?.kind ?? (scenarioKey.startsWith("S2") ? "shortfall" : "purchase");
}

/**
 * Picks the supplier the rules engine treats as the default for a product:
 * the shortest lead time among those with terms on file. The agent is free to
 * choose differently and justify it; this is only the reference baseline.
 */
async function defaultSupplier(productId: string): Promise<SupplierTerms | null> {
  const term = await prisma.supplierTerm.findFirst({
    where: { productId },
    include: { supplier: true },
    orderBy: { leadTimeDays: "asc" },
  });
  if (!term) return null;

  return {
    supplierId: term.supplierId,
    supplierName: term.supplier.name,
    unitPrice: term.unitPrice,
    moq: term.moq,
    lotSize: term.lotSize,
    leadTimeDays: term.leadTimeDays,
  };
}

export async function buildScenarioSetup(
  scenarioKey: string
): Promise<ScenarioSetup> {
  if (scenarioKind(scenarioKey) === "shortfall") {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: S2A_PO_ID },
      include: { product: true, node: true, supplier: true },
    });
    if (!po) {
      throw new Error(
        `Scenario ${scenarioKey} needs purchase order ${S2A_PO_ID}. Seed the database first.`
      );
    }

    return {
      scenarioKey,
      kind: "shortfall",
      recommendationId: null,
      triggerPoId: po.id,
      title: `${po.product.name} — supplier shortfall`,
      subtitle: `${po.supplier.name} confirmed ${po.confirmedQty ?? 0} of ${po.quantity} units at ${po.node.name}`,
      userMessage: frameSupplierShortfall({
        purchaseOrderId: po.id,
        productId: po.productId,
        productName: po.product.name,
        nodeId: po.nodeId,
        nodeName: po.node.name,
        supplierId: po.supplierId,
        supplierName: po.supplier.name,
        orderedQty: po.quantity,
        confirmedQty: po.confirmedQty ?? 0,
      }),
    };
  }

  const rec = await prisma.recommendation.findUnique({
    where: { scenarioKey },
    include: { product: true, node: true },
  });
  if (!rec) {
    throw new Error(
      `No recommendation with scenarioKey "${scenarioKey}". Seed the database first.`
    );
  }

  return {
    scenarioKey,
    kind: "purchase",
    recommendationId: rec.id,
    triggerPoId: null,
    title: `${rec.product.name} — recommendation review`,
    subtitle: `System recommends ${rec.recommendedQty} units at ${rec.node.name}`,
    userMessage: framePurchaseReview({
      scenarioKey,
      productId: rec.productId,
      productName: rec.product.name,
      productSku: rec.product.sku,
      nodeId: rec.nodeId,
      nodeCode: rec.node.code,
      nodeName: rec.node.name,
      recommendedQty: rec.recommendedQty,
    }),
  };
}

export async function computePurchaseTruth(
  recommendationId: string
): Promise<PurchaseTruth | null> {
  const s = await loadSituation(recommendationId);
  if (!s) return null;

  const supplier = await defaultSupplier(s.productId);
  if (!supplier) return null;

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
    decision: truth.decision,
    quantity: truth.quantity,
    bindingConstraint: truth.bindingConstraint,
    escalate: truth.escalate,
    reason: truth.reason,
  };
}

export async function computeShortfallTruth(
  poId: string = S2A_PO_ID
): Promise<ShortfallTruth | null> {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
  if (!po) return null;

  const [inv, forecast, constraint, terms, allIncoming] = await Promise.all([
    prisma.inventory.findUnique({
      where: { productId_nodeId: { productId: po.productId, nodeId: po.nodeId } },
    }),
    prisma.demandForecast.findUnique({
      where: { productId_nodeId: { productId: po.productId, nodeId: po.nodeId } },
    }),
    prisma.nodeConstraint.findUnique({ where: { nodeId: po.nodeId } }),
    prisma.supplierTerm.findMany({
      where: { productId: po.productId, supplierId: { not: po.supplierId } },
      include: { supplier: true },
    }),
    computeIncoming(po.productId, po.nodeId, po.id),
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
    otherIncoming: allIncoming,
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
    outcome: truth.outcome,
    quantity: truth.quantity,
    chosenSupplierId: truth.chosenSupplier?.supplierId ?? null,
    reason: truth.reason,
  };
}