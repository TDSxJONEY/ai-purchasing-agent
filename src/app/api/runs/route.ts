import { jsonError, jsonOk } from "@/lib/http";
import { startScenarioRun } from "@/agent/start";
import { isScenarioKey } from "@/lib/scenarios";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { scenarioKey?: string; mode?: string };
    if (!body.scenarioKey || !isScenarioKey(body.scenarioKey)) {
      return jsonError("A valid scenarioKey is required.");
    }

    const run = await startScenarioRun(body.scenarioKey, body.mode);
    return jsonOk({ runId: run.id, status: run.status }, 201);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to start run", 500);
  }
}
