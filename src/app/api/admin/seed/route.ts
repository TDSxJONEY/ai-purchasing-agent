import { jsonError, jsonOk } from "@/lib/http";
import { adminAuthorized } from "@/lib/admin";
import { seedDatabase } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!adminAuthorized(req)) {
    return jsonError("Unauthorized.", 401);
  }

  try {
    const counts = await seedDatabase();
    return jsonOk({ ok: true, counts });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Seed failed", 500);
  }
}
