import { jsonError, jsonOk } from "@/lib/http";
import { approveRun } from "@/domain/execute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await params;
    const result = await approveRun(runId);
    return jsonOk(result);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Approval failed", 500);
  }
}
