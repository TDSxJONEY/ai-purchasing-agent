/**
 * Live-state readers.
 *
 * Everything here reads the database AT CALL TIME. Nothing caches, and nothing
 * accepts a snapshot from the caller. That is deliberate: the validator's whole
 * value comes from seeing the world as it is at execution, not as the agent saw
 * it during investigation.
 */

import { PoStatus } from "@prisma/client";
import { prisma, withRetry } from "@/lib/db";
import type { ValidationInput } from "./validate";

/**
 * Σ quantity arriving for this product+node from orders that are actually live.
 *
 * A PARTIAL order contributes only its CONFIRMED quantity. Counting the ordered
 * amount would hide exactly the gap Scenario 2 is about.
 */
export async function computeIncoming(
  productId: string,
  nodeId: string,
  excludePoId?: string
): Promise<number> {
  const pos = await withRetry(() =>
    prisma.purchaseOrder.findMany({
      where: {
        productId,
        nodeId,
        status: { in: [PoStatus.OPEN, PoStatus.PARTIAL] },
        ...(excludePoId ? { id: { not: excludePoId } } : {}),
      },
      select: { quantity: true, confirmedQty: true, status: true },
    })
  );

  return pos.reduce((sum, po) => {
    const effective =
      po.status === PoStatus.PARTIAL && po.confirmedQty !== null
        ? po.confirmedQty
        : po.quantity;
    return sum + effective;
  }, 0);
}

/**
 * Committed spend for a node, derived from live orders rather than read from the
 * stored counter. Used to assert the budgetUsed invariant in tests and to detect
 * accounting drift.
 */
export async function computeCommittedSpend(nodeId: string): Promise<number> {
  const pos = await prisma.purchaseOrder.findMany({
    where: { nodeId, status: { in: [PoStatus.OPEN, PoStatus.PARTIAL] } },
    select: { quantity: true, unitPrice: true },
  });
  return pos.reduce((sum, po) => sum + po.quantity * po.unitPrice, 0);
}

export interface SituationSnapshot {
  productId: string;
  productName: string;
  productSku: string;
  nodeId: string;
  nodeCode: string;
  nodeName: string;
  recommendedQty: number;
  onHand: number;
  reserved: number;
  available: number;
  horizonDays: number;
  forecastUnits: number;
  safetyStock: number;
  actualLast7d: number;
  forecastUpdatedAt: Date;
  incoming: number;
  budgetTotal: number;
  budgetUsed: number;
  storageCapacity: number;
  storageUsed: number;
}

/**
 * Assembles the full picture for a recommendation. Used by tests and by the UI's
 * operational-data panel.
 *
 * NOT used by the agent — the agent must gather this piecemeal through tools, so
 * that the trace shows which information it chose to seek.
 */
export async function loadSituation(
  recommendationId: string
): Promise<SituationSnapshot | null> {
  const rec = await withRetry(() =>
    prisma.recommendation.findUnique({
      where: { id: recommendationId },
      include: { product: true, node: true },
    })
  );
  if (!rec) return null;

  const [inventory, forecast, constraint, incoming] = await Promise.all([
    prisma.inventory.findUnique({
      where: { productId_nodeId: { productId: rec.productId, nodeId: rec.nodeId } },
    }),
    prisma.demandForecast.findUnique({
      where: { productId_nodeId: { productId: rec.productId, nodeId: rec.nodeId } },
    }),
    prisma.nodeConstraint.findUnique({ where: { nodeId: rec.nodeId } }),
    computeIncoming(rec.productId, rec.nodeId),
  ]);

  const onHand = inventory?.onHand ?? 0;
  const reserved = inventory?.reserved ?? 0;

  return {
    productId: rec.productId,
    productName: rec.product.name,
    productSku: rec.product.sku,
    nodeId: rec.nodeId,
    nodeCode: rec.node.code,
    nodeName: rec.node.name,
    recommendedQty: rec.recommendedQty,
    onHand,
    reserved,
    available: onHand - reserved,
    horizonDays: forecast?.horizonDays ?? 0,
    forecastUnits: forecast?.forecastUnits ?? 0,
    safetyStock: forecast?.safetyStock ?? 0,
    actualLast7d: forecast?.actualLast7d ?? 0,
    forecastUpdatedAt: forecast?.updatedAt ?? new Date(0),
    incoming,
    budgetTotal: constraint?.budgetTotal ?? 0,
    budgetUsed: constraint?.budgetUsed ?? 0,
    storageCapacity: constraint?.storageCapacity ?? 0,
    storageUsed: constraint?.storageUsed ?? 0,
  };
}

/**
 * Builds the validator's input by re-reading every figure from the database.
 *
 * `budgetUsedExcludingThisPo` backs out this order's own cost, since the create
 * step already added it to the counter. Without that, V5 would compare the order
 * against a budget that has already been debited for it.
 */
export async function loadValidationInput(
  poId: string,
  agentStatedQuantity: number | null
): Promise<ValidationInput | null> {
  const po = await withRetry(() =>
    prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { supplier: true },
    })
  );
  if (!po) return null;

  const [terms, inventory, forecast, constraint, otherIncoming] =
    await Promise.all([
      prisma.supplierTerm.findUnique({
        where: {
          supplierId_productId: {
            supplierId: po.supplierId,
            productId: po.productId,
          },
        },
      }),
      prisma.inventory.findUnique({
        where: { productId_nodeId: { productId: po.productId, nodeId: po.nodeId } },
      }),
      prisma.demandForecast.findUnique({
        where: { productId_nodeId: { productId: po.productId, nodeId: po.nodeId } },
      }),
      prisma.nodeConstraint.findUnique({ where: { nodeId: po.nodeId } }),
      computeIncoming(po.productId, po.nodeId, po.id),
    ]);

  const ownCostCounted =
    po.status === PoStatus.OPEN || po.status === PoStatus.PARTIAL
      ? po.quantity * po.unitPrice
      : 0;

  return {
    poQuantity: po.quantity,
    poUnitPrice: po.unitPrice,
    poSupplierId: po.supplierId,
    poSupplierName: po.supplier.name,
    agentStatedQuantity,
    supplierMoq: terms?.moq ?? 0,
    supplierLotSize: terms?.lotSize ?? 1,
    supplierSuppliesProduct: terms !== null,
    onHand: inventory?.onHand ?? 0,
    reserved: inventory?.reserved ?? 0,
    forecastUnits: forecast?.forecastUnits ?? 0,
    safetyStock: forecast?.safetyStock ?? 0,
    otherIncoming,
    storageCapacity: constraint?.storageCapacity ?? 0,
    storageUsed: constraint?.storageUsed ?? 0,
    budgetTotal: constraint?.budgetTotal ?? 0,
    budgetUsedExcludingThisPo: Math.max(
      0,
      (constraint?.budgetUsed ?? 0) - ownCostCounted
    ),
  };
}

/**
 * Demo affordance: consumes budget at a node as if another buyer had committed
 * spend between investigation and approval.
 *
 * This is the lever that makes the state-drift failure reproducible on demand in
 * the UI. It writes nothing the agent can see during investigation, which is the
 * entire point.
 */
export async function simulateConcurrentSpend(
  nodeId: string,
  amount: number
): Promise<void> {
  await prisma.nodeConstraint.update({
    where: { nodeId },
    data: { budgetUsed: { increment: amount } },
  });
}