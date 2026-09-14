import { jsonError, jsonOk } from "@/lib/http";
import { stepRun } from "@/agent/loop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await params;
    const outcome = await stepRun(runId);
    return jsonOk(outcome);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Step failed", 500);
  }
}
