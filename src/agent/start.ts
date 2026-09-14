import { DecisionType, RunStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { isScenarioKey } from "@/lib/scenarios";
import { buildScenarioSetup, S2A_PO_ID } from "@/domain/scenarios";
import { frameReinvestigation } from "./prompt";
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

  const setup = await buildScenarioSetup(scenarioKey);

  if (setup.recommendationId) {
    await prisma.recommendation.update({
      where: { id: setup.recommendationId },
      data: { status: "IN_REVIEW" },
    });
  }

  return createRun({
    scenarioKey,
    recommendationId: setup.recommendationId,
    triggerPoId: setup.triggerPoId,
    userMessage: setup.userMessage,
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
      where: { id: S2A_PO_ID },
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
