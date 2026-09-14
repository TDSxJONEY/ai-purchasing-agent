import { jsonError, jsonOk } from "@/lib/http";
import { withRetry } from "@/lib/db";
import { loadQueue } from "@/agent/start";
import { SCENARIO_MAP } from "@/lib/scenarios";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const items = await withRetry(() => loadQueue());
    return jsonOk({
      items: items.map((item) => ({
        ...item,
        catalog: SCENARIO_MAP[item.scenarioKey] ?? null,
      })),
    });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to load queue", 500);
  }
}
