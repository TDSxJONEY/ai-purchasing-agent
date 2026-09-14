import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/db";
import { startReinvestigation } from "@/agent/start";
import { buildReinvestigationBrief, type ValidationOutcome } from "@/domain/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await params;
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      include: {
        validations: { orderBy: { createdAt: "desc" } },
        resultPo: { include: { supplier: true } },
      },
    });
    if (!run) return jsonError("Run not found.", 404);

    const latest = run.validations[0];
    const outcome = latest?.checks as unknown as ValidationOutcome | undefined;
    const brief =
      outcome && run.resultPo
        ? buildReinvestigationBrief(outcome, {
            poQuantity: run.resultPo.quantity,
            supplierName: run.resultPo.supplier.name,
          })
        : `Previous run ${runId} failed validation. Re-read current operational state before deciding.`;

    const next = await startReinvestigation(runId, brief);
    return jsonOk({ runId: next.id, status: next.status }, 201);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Reinvestigation failed", 500);
  }
}
