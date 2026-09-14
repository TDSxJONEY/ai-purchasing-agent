import { jsonError, jsonOk } from "@/lib/http";
import { adminAuthorized } from "@/lib/admin";
import { simulateConcurrentSpend } from "@/domain/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!adminAuthorized(req)) {
    return jsonError("Unauthorized.", 401);
  }

  try {
    const body = (await req.json()) as { nodeId?: string; amount?: number };
    if (!body.nodeId || typeof body.amount !== "number" || body.amount <= 0) {
      return jsonError("nodeId and a positive amount are required.");
    }

    await simulateConcurrentSpend(body.nodeId, Math.trunc(body.amount));
    return jsonOk({ ok: true, nodeId: body.nodeId, amount: Math.trunc(body.amount) });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Spend simulation failed", 500);
  }
}
