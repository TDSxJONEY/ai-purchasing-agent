import { jsonError, jsonOk } from "@/lib/http";
import { loadRun } from "@/agent/start";
import { loadSituation } from "@/domain/state";
import { SCENARIO_MAP } from "@/lib/scenarios";
import { buildReinvestigationBrief, type ValidationOutcome } from "@/domain/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await params;
    const run = await loadRun(runId);
    if (!run) return jsonError("Run not found.", 404);

    const situation = run.recommendationId
      ? await loadSituation(run.recommendationId)
      : run.triggerPo
        ? {
            productId: run.triggerPo.productId,
            nodeId: run.triggerPo.nodeId,
            productName: run.triggerPo.product.name,
            productSku: run.triggerPo.product.sku,
            nodeCode: run.triggerPo.node.code,
            nodeName: run.triggerPo.node.name,
            recommendedQty: run.triggerPo.quantity,
          }
        : null;

    const latestValidation = run.validations[0] ?? null;
    const outcome = latestValidation?.checks as unknown as ValidationOutcome | null;
    const brief =
      outcome && !outcome.passed && run.resultPo
        ? buildReinvestigationBrief(outcome, {
            poQuantity: run.resultPo.quantity,
            supplierName: run.resultPo.supplier.name,
          })
        : null;

    return jsonOk({
      run,
      situation,
      catalog: SCENARIO_MAP[run.scenarioKey] ?? null,
      brief,
    });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to load run", 500);
  }
}
