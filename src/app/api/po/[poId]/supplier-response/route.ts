import { PoStatus } from "@prisma/client";
import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ poId: string }> }
) {
  try {
    const { poId } = await params;
    const body = (await req.json()) as { confirmedQty?: number };

    if (typeof body.confirmedQty !== "number" || body.confirmedQty < 0) {
      return jsonError("confirmedQty must be a non-negative number.");
    }

    const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
    if (!po) return jsonError("Purchase order not found.", 404);

    const confirmedQty = Math.trunc(body.confirmedQty);
    const status =
      confirmedQty >= po.quantity
        ? PoStatus.OPEN
        : confirmedQty === 0
          ? PoStatus.CANCELLED
          : PoStatus.PARTIAL;

    const updated = await prisma.purchaseOrder.update({
      where: { id: poId },
      data: { confirmedQty, status },
    });

    return jsonOk({ po: updated });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Update failed", 500);
  }
}
