import { DecisionType, RunStatus } from "@prisma/client";
import { prisma, withRetry } from "@/lib/db";
import { env } from "@/lib/env";
import { SCENARIO_MAP, isScenarioKey } from "@/lib/scenarios";
import {
  framePurchaseReview,
  frameReinvestigation,
  frameSupplierShortfall,
} from "./prompt";
import { createRun } from "./loop";

const ORDERING_DECISIONS = new Set<string>([
  DecisionType.ACCEPT,
  DecisionType.MODIFY,
  DecisionType.CREATE_SUPPLEMENTARY_PO,
]);

export function isOrderingDecision(decision: string): boolean {
  return ORDERING_DECISIONS.has(decision);
}

export async function startScenarioRun(scenarioKey: string, mode?: string) {
  if (!isScenarioKey(scenarioKey)) {
    throw new Error(`Unknown scenario "${scenarioKey}".`);
  }

  const catalog = SCENARIO_MAP[scenarioKey];
  let userMessage: string;
  let recommendationId: string | null = catalog.recommendationId;
  let triggerPoId: string | null = catalog.triggerPoId;

  if (catalog.kind === "shortfall") {
    const po = await withRetry(() =>
      prisma.purchaseOrder.findUnique({
        where: { id: catalog.triggerPoId! },
        include: { product: true, node: true, supplier: true },
      })
    );
    if (!po) throw new Error("S2-A purchase order missing. Run: npm run db:seed");

    triggerPoId = po.id;
    userMessage = frameSupplierShortfall({
      purchaseOrderId: po.id,
      productId: po.productId,
      productName: po.product.name,
      nodeId: po.nodeId,
      nodeName: po.node.name,
      supplierName: po.supplier.name,
      orderedQty: po.quantity,
      confirmedQty: po.confirmedQty ?? 0,
    });
  } else {
    const rec = await withRetry(() =>
      prisma.recommendation.findUnique({
        where: { scenarioKey },
        include: { product: true, node: true },
      })
    );
    if (!rec) throw new Error(`No recommendation "${scenarioKey}". Run: npm run db:seed`);

    recommendationId = rec.id;
    userMessage = framePurchaseReview({
      scenarioKey,
      productId: rec.productId,
      productName: rec.product.name,
      productSku: rec.product.sku,
      nodeId: rec.nodeId,
      nodeCode: rec.node.code,
      nodeName: rec.node.name,
      recommendedQty: rec.recommendedQty,
    });

    await prisma.recommendation.update({
      where: { id: rec.id },
      data: { status: "IN_REVIEW" },
    });
  }

  return createRun({
    scenarioKey,
    recommendationId,
    triggerPoId,
    userMessage,
    mode: mode ?? env.AGENT_MODE,
  });
}

export async function startReinvestigation(runId: string, brief: string) {
  const parent = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!parent) throw new Error(`Run ${runId} not found.`);

  return createRun({
    scenarioKey: parent.scenarioKey,
    recommendationId: parent.recommendationId,
    triggerPoId: parent.triggerPoId,
    userMessage: frameReinvestigation(brief),
    mode: parent.mode,
  });
}

const runInclude = {
  steps: { orderBy: { index: "asc" as const } },
  decision: { include: { supplier: true } },
  validations: { orderBy: { createdAt: "desc" as const } },
  resultPo: { include: { supplier: true } },
  recommendation: { include: { product: true, node: true } },
  triggerPo: { include: { supplier: true, product: true, node: true } },
};

export async function loadRun(runId: string) {
  return prisma.agentRun.findUnique({
    where: { id: runId },
    include: runInclude,
  });
}

export async function loadLatestRun(scenarioKey: string) {
  return prisma.agentRun.findFirst({
    where: { scenarioKey },
    orderBy: { createdAt: "desc" },
    include: runInclude,
  });
}

export async function loadQueue() {
  const [recommendations, shortfallPo, latestRuns] = await Promise.all([
    prisma.recommendation.findMany({
      include: { product: true, node: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.purchaseOrder.findUnique({
      where: { id: "po_s2a_partial" },
      include: { product: true, node: true, supplier: true },
    }),
    prisma.agentRun.findMany({
      orderBy: { createdAt: "desc" },
      distinct: ["scenarioKey"],
      select: { scenarioKey: true, status: true, id: true, createdAt: true },
    }),
  ]);

  const latestByKey = Object.fromEntries(latestRuns.map((r) => [r.scenarioKey, r]));

  const purchaseItems = recommendations.map((rec) => ({
    scenarioKey: rec.scenarioKey,
    kind: "purchase" as const,
    title: rec.product.name,
    sku: rec.product.sku,
    nodeName: rec.node.name,
    recommendedQty: rec.recommendedQty,
    recommendationStatus: rec.status,
    latestRun: latestByKey[rec.scenarioKey] ?? null,
  }));

  const shortfallItem = shortfallPo
    ? {
        scenarioKey: "S2-A",
        kind: "shortfall" as const,
        title: shortfallPo.product.name,
        sku: shortfallPo.product.sku,
        nodeName: shortfallPo.node.name,
        recommendedQty: null as number | null,
        recommendationStatus: "PENDING" as const,
        latestRun: latestByKey["S2-A"] ?? null,
      }
    : null;

  return shortfallItem ? [...purchaseItems, shortfallItem] : purchaseItems;
}

export function terminalStatusForDecision(decision: DecisionType): RunStatus {
  switch (decision) {
    case DecisionType.ESCALATE:
      return RunStatus.ESCALATED;
    case DecisionType.NO_ACTION:
    case DecisionType.REJECT:
    case DecisionType.INVESTIGATE:
      return RunStatus.NO_ACTION;
    default:
      return RunStatus.AWAITING_APPROVAL;
  }
}
