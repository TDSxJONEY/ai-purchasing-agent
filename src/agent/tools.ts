/**
 * Agent tool registry.
 *
 * Design constraints, all deliberate:
 *
 *  - No tool exposes src/domain/rules.ts. The agent receives raw operational
 *    data and must reason to a decision itself. Handing it the calculator would
 *    make validation circular.
 *
 *  - Tool parameters are FLAT and PRIMITIVE. No nested objects, no unions, no
 *    $ref. Models routed through OpenRouter vary in how well they handle complex
 *    JSON Schema, and a malformed argument object is the most common failure.
 *
 *  - The decision is itself a tool (submit_decision) rather than a
 *    response_format schema. Structured-output support varies by provider;
 *    tool calling is the common denominator.
 *
 *  - The agent has NO write tools. Its only action is submitting a decision.
 *    Creating the purchase order is done by deterministic backend code after
 *    human approval. "What actions should the agent be allowed to perform" is
 *    answered here: none that change state.
 *
 *  - Derived arithmetic that models reliably get wrong (date differences) is
 *    precomputed as DATA — forecast_age_days is supplied, but no threshold is.
 *    Judging whether that age is acceptable remains the agent's call.
 *
 * IDENTIFIER RESOLUTION: an observed failure mode is the model passing a SKU
 * ("SKU-EARBUD-01") or node code ("DEL-NCR-01") where an id was expected, then
 * reading the resulting empty result as "no data exists" and deciding on that
 * false premise. Silent not-found is a dangerous failure here, so every lookup
 * resolves by id OR sku/code, and an unresolvable identifier returns an explicit
 * error naming what was tried rather than an innocuous "not found".
 */

import { PoStatus } from "@prisma/client";
import { prisma, withRetry } from "@/lib/db";

const DAY = 24 * 60 * 60 * 1000;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
  /** True for the terminal tool that ends the loop. */
  terminal?: boolean;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

// ─── Identifier resolution ──────────────────────────────────────────────────

async function resolveProductId(raw: unknown): Promise<string | null> {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  const product = await withRetry(() =>
    prisma.product.findFirst({
      where: { OR: [{ id: value }, { sku: value }] },
      select: { id: true },
    })
  );
  return product?.id ?? null;
}

async function resolveNodeId(raw: unknown): Promise<string | null> {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  const node = await withRetry(() =>
    prisma.node.findFirst({
      where: { OR: [{ id: value }, { code: value }] },
      select: { id: true },
    })
  );
  return node?.id ?? null;
}

function unresolved(kind: "product" | "node", raw: unknown) {
  return {
    error: `No ${kind} matches "${String(raw)}". Use the ${kind} ID exactly as given in the situation description. Do not substitute the ${
      kind === "product" ? "SKU" : "node code"
    } or name.`,
  };
}

// ─── Read tools ─────────────────────────────────────────────────────────────

const getInventory: ToolDefinition = {
  name: "get_inventory",
  description:
    "Current stock for a product at a fulfilment node. Returns units physically on hand and units already reserved against customer orders.",
  parameters: {
    type: "object",
    properties: {
      product_id: { type: "string", description: "Product identifier" },
      node_id: { type: "string", description: "Fulfilment node identifier" },
    },
    required: ["product_id", "node_id"],
    additionalProperties: false,
  },
  handler: async ({ product_id, node_id }) => {
    const productId = await resolveProductId(product_id);
    if (!productId) return unresolved("product", product_id);
    const nodeId = await resolveNodeId(node_id);
    if (!nodeId) return unresolved("node", node_id);

    const inv = await withRetry(() =>
      prisma.inventory.findUnique({
        where: { productId_nodeId: { productId, nodeId } },
      })
    );

    if (!inv) {
      return {
        found: false,
        note: "This product and node are both valid, but no stock record exists for the pair. Treat on-hand as zero.",
        on_hand: 0,
        reserved: 0,
        available: 0,
      };
    }

    return {
      found: true,
      on_hand: inv.onHand,
      reserved: inv.reserved,
      available: inv.onHand - inv.reserved,
    };
  },
};

const getDemandForecast: ToolDefinition = {
  name: "get_demand_forecast",
  description:
    "Demand forecast for a product at a node, plus the actual units sold in the last 7 days and how old the forecast is. Use the actuals and the age to judge whether the forecast can be trusted.",
  parameters: {
    type: "object",
    properties: {
      product_id: { type: "string", description: "Product identifier" },
      node_id: { type: "string", description: "Fulfilment node identifier" },
    },
    required: ["product_id", "node_id"],
    additionalProperties: false,
  },
  handler: async ({ product_id, node_id }) => {
    const productId = await resolveProductId(product_id);
    if (!productId) return unresolved("product", product_id);
    const nodeId = await resolveNodeId(node_id);
    if (!nodeId) return unresolved("node", node_id);

    const f = await withRetry(() =>
      prisma.demandForecast.findUnique({
        where: { productId_nodeId: { productId, nodeId } },
      })
    );

    if (!f) {
      return {
        found: false,
        note: "No forecast on file for this product and node. There is no demand evidence to reason from.",
      };
    }

    return {
      found: true,
      horizon_days: f.horizonDays,
      forecast_units: f.forecastUnits,
      safety_stock: f.safetyStock,
      actual_units_last_7_days: f.actualLast7d,
      forecast_last_updated: f.updatedAt.toISOString().slice(0, 10),
      forecast_age_days: Math.round((Date.now() - f.updatedAt.getTime()) / DAY),
    };
  },
};

const getOpenPurchaseOrders: ToolDefinition = {
  name: "get_open_purchase_orders",
  description:
    "Purchase orders already placed for this product at this node that have not yet been received. A PARTIAL order means the supplier confirmed fewer units than were ordered; only the confirmed quantity will actually arrive.",
  parameters: {
    type: "object",
    properties: {
      product_id: { type: "string", description: "Product identifier" },
      node_id: { type: "string", description: "Fulfilment node identifier" },
    },
    required: ["product_id", "node_id"],
    additionalProperties: false,
  },
  handler: async ({ product_id, node_id }) => {
    const productId = await resolveProductId(product_id);
    if (!productId) return unresolved("product", product_id);
    const nodeId = await resolveNodeId(node_id);
    if (!nodeId) return unresolved("node", node_id);

    const pos = await withRetry(() =>
      prisma.purchaseOrder.findMany({
        where: {
          productId,
          nodeId,
          status: { in: [PoStatus.OPEN, PoStatus.PARTIAL] },
        },
        include: { supplier: true },
        orderBy: { expectedDate: "asc" },
      })
    );

    return {
      count: pos.length,
      total_units_arriving: pos.reduce(
        (sum, po) =>
          sum +
          (po.status === PoStatus.PARTIAL && po.confirmedQty !== null
            ? po.confirmedQty
            : po.quantity),
        0
      ),
      orders: pos.map((po) => ({
        purchase_order_id: po.id,
        supplier_id: po.supplierId,
        supplier: po.supplier.name,
        ordered_quantity: po.quantity,
        confirmed_quantity: po.confirmedQty,
        units_that_will_actually_arrive:
          po.status === PoStatus.PARTIAL && po.confirmedQty !== null
            ? po.confirmedQty
            : po.quantity,
        status: po.status,
        unit_price: po.unitPrice,
        expected_date: po.expectedDate.toISOString().slice(0, 10),
        days_until_arrival: Math.max(
          0,
          Math.round((po.expectedDate.getTime() - Date.now()) / DAY)
        ),
      })),
    };
  },
};

const getSupplierTerms: ToolDefinition = {
  name: "get_supplier_terms",
  description:
    "All suppliers that can supply a product, with unit price, minimum order quantity, lot size (orders must be a whole multiple of it) and lead time in days.",
  parameters: {
    type: "object",
    properties: {
      product_id: { type: "string", description: "Product identifier" },
    },
    required: ["product_id"],
    additionalProperties: false,
  },
  handler: async ({ product_id }) => {
    const productId = await resolveProductId(product_id);
    if (!productId) return unresolved("product", product_id);

    const terms = await withRetry(() =>
      prisma.supplierTerm.findMany({
        where: { productId },
        include: { supplier: true },
        orderBy: { leadTimeDays: "asc" },
      })
    );

    return {
      count: terms.length,
      suppliers: terms.map((t) => ({
        supplier_id: t.supplierId,
        supplier_name: t.supplier.name,
        unit_price: t.unitPrice,
        minimum_order_quantity: t.moq,
        lot_size: t.lotSize,
        lead_time_days: t.leadTimeDays,
        reliability_score: t.supplier.reliabilityScore,
      })),
    };
  },
};

const getNodeConstraints: ToolDefinition = {
  name: "get_node_constraints",
  description:
    "Purchasing budget and storage capacity for a fulfilment node, with how much of each is already committed. Budget figures are in rupees; storage figures are in units.",
  parameters: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Fulfilment node identifier" },
    },
    required: ["node_id"],
    additionalProperties: false,
  },
  handler: async ({ node_id }) => {
    const nodeId = await resolveNodeId(node_id);
    if (!nodeId) return unresolved("node", node_id);

    const c = await withRetry(() =>
      prisma.nodeConstraint.findUnique({ where: { nodeId } })
    );
    if (!c) {
      return { found: false, note: "No constraints on file for this node." };
    }

    return {
      found: true,
      budget_total: c.budgetTotal,
      budget_committed: c.budgetUsed,
      budget_remaining: c.budgetTotal - c.budgetUsed,
      storage_capacity_units: c.storageCapacity,
      storage_used_units: c.storageUsed,
      storage_free_units: c.storageCapacity - c.storageUsed,
      note: "storage_free_units counts only stock physically in the building. Units already on order are NOT deducted here, and they will need space in this same building when they arrive.",
    };
  },
};

const getPurchaseOrder: ToolDefinition = {
  name: "get_purchase_order",
  description:
    "Details of a single purchase order by id, including what the supplier has actually confirmed. Use when investigating a supplier shortfall.",
  parameters: {
    type: "object",
    properties: {
      purchase_order_id: {
        type: "string",
        description: "Purchase order identifier",
      },
    },
    required: ["purchase_order_id"],
    additionalProperties: false,
  },
  handler: async ({ purchase_order_id }) => {
    const po = await withRetry(() =>
      prisma.purchaseOrder.findUnique({
        where: { id: String(purchase_order_id ?? "").trim() },
        include: { supplier: true, product: true, node: true },
      })
    );
    if (!po) {
      return {
        error: `No purchase order matches "${purchase_order_id}". Use the purchase order ID exactly as given in the situation description.`,
      };
    }

    return {
      found: true,
      purchase_order_id: po.id,
      product_id: po.productId,
      product_name: po.product.name,
      node_id: po.nodeId,
      node_name: po.node.name,
      supplier_id: po.supplierId,
      supplier_name: po.supplier.name,
      ordered_quantity: po.quantity,
      confirmed_quantity: po.confirmedQty,
      shortfall:
        po.confirmedQty === null
          ? 0
          : Math.max(0, po.quantity - po.confirmedQty),
      unit_price: po.unitPrice,
      status: po.status,
      expected_date: po.expectedDate.toISOString().slice(0, 10),
    };
  },
};

// ─── Terminal tool ──────────────────────────────────────────────────────────

const submitDecision: ToolDefinition = {
  name: "submit_decision",
  description:
    "Submit your final decision. Call this exactly once, after you have gathered the information you need. This ends the investigation. It does not create a purchase order — a human buyer approves that separately.",
  parameters: {
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: [
          "ACCEPT",
          "MODIFY",
          "REJECT",
          "INVESTIGATE",
          "CREATE_SUPPLEMENTARY_PO",
          "NO_ACTION",
          "ESCALATE",
        ],
        description:
          "Reviewing a recommendation: ACCEPT the recommended quantity unchanged, MODIFY it to a different quantity, REJECT to buy nothing at all, or INVESTIGATE when the demand evidence is too weak to justify committing money. Handling a supplier shortfall: CREATE_SUPPLEMENTARY_PO to source the gap elsewhere, or NO_ACTION when existing cover is already sufficient. ESCALATE only when no acceptable option exists and a human must intervene.",
      },
      quantity: {
        type: "integer",
        description:
          "Units to order. Use 0 for REJECT, NO_ACTION, ESCALATE or INVESTIGATE. Must be at least the supplier's minimum order quantity and a whole multiple of the lot size.",
      },
      supplier_id: {
        type: "string",
        description:
          "The supplier_id value returned by get_supplier_terms, for the supplier you are ordering from. Use an empty string when not ordering.",
      },
      binding_constraint: {
        type: "string",
        enum: [
          "DEMAND",
          "STORAGE",
          "BUDGET",
          "MOQ",
          "EVIDENCE",
          "LEAD_TIME",
          "NONE",
        ],
        description:
          "The single factor that actually determined the outcome. If you reduced a quantity, this is what forced the reduction. If no order is possible because the supplier's minimum cannot be reached, it is MOQ. If you are not acting because demand is already covered, it is DEMAND. If you are not acting because the forecast cannot be trusted, it is EVIDENCE.",
      },
      urgent: {
        type: "boolean",
        description:
          "True if stock will run out before the chosen supplier can deliver.",
      },
      rationale: {
        type: "string",
        description:
          "Two to four sentences explaining the decision, citing the specific figures you relied on.",
      },
      factors: {
        type: "array",
        items: { type: "string" },
        description:
          "Three to six short bullet points, each stating one figure that mattered, e.g. 'Open PO of 100 units arrives in 5 days'.",
      },
    },
    required: [
      "decision",
      "quantity",
      "supplier_id",
      "binding_constraint",
      "urgent",
      "rationale",
      "factors",
    ],
    additionalProperties: false,
  },
  terminal: true,
  handler: async (args) => {
    // Recorded by the loop, which owns persistence. Echoed back so the model
    // sees its submission was accepted.
    return { accepted: true, decision: args.decision, quantity: args.quantity };
  },
};

// ─── Registry ───────────────────────────────────────────────────────────────

export const TOOLS: ToolDefinition[] = [
  getInventory,
  getDemandForecast,
  getOpenPurchaseOrders,
  getSupplierTerms,
  getNodeConstraints,
  getPurchaseOrder,
  submitDecision,
];

export const TOOL_MAP: Record<string, ToolDefinition> = Object.fromEntries(
  TOOLS.map((t) => [t.name, t])
);

/** OpenAI-compatible tool array for the OpenRouter request body. */
export function toolsForRequest() {
  return TOOLS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Executes a tool by name. Never throws: a tool error is returned as content the
 * model can read and react to, because killing the run on a bad argument teaches
 * the model nothing and loses the trace.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; result: unknown }> {
  const tool = TOOL_MAP[name];
  if (!tool) {
    return {
      ok: false,
      result: {
        error: `Unknown tool "${name}". Available: ${TOOLS.map((t) => t.name).join(", ")}.`,
      },
    };
  }

  const missing = tool.parameters.required.filter(
    (k) => args[k] === undefined || args[k] === null
  );
  if (missing.length > 0) {
    return {
      ok: false,
      result: { error: `Missing required argument(s): ${missing.join(", ")}.` },
    };
  }

  try {
    return { ok: true, result: await tool.handler(args) };
  } catch (err) {
    return {
      ok: false,
      result: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}