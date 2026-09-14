import "dotenv/config";
import { PrismaClient, PoStatus } from "@prisma/client";

const prisma = new PrismaClient();

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY);

/**
 * Seed data for docs/decision-spec.md §8.
 *
 * IDs are explicit and readable rather than cuid() so that tests, replay
 * fixtures and this file all refer to the same rows by name. The seed is
 * idempotent: it wipes and recreates, so it is safe to re-run and safe to
 * expose behind the admin reset endpoint.
 *
 * Prices are integer rupees throughout.
 */

async function wipe() {
  // FK-safe order. PurchaseOrder has a self-relation (parentPoId), so that
  // column is nulled before the table is emptied.
  await prisma.validationResult.deleteMany();
  await prisma.agentDecision.deleteMany();
  await prisma.agentStep.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.purchaseOrder.updateMany({ data: { parentPoId: null } });
  await prisma.purchaseOrder.deleteMany();
  await prisma.recommendation.deleteMany();
  await prisma.nodeConstraint.deleteMany();
  await prisma.demandForecast.deleteMany();
  await prisma.inventory.deleteMany();
  await prisma.supplierTerm.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.product.deleteMany();
  await prisma.node.deleteMany();
}

async function main() {
  console.log("Wiping existing data...");
  await wipe();

  // ─── Nodes ──────────────────────────────────────────────────────────────

  await prisma.node.createMany({
    data: [
      { id: "node_delncr", code: "DEL-NCR-01", name: "Delhi NCR Hub", city: "Delhi" },
      { id: "node_mumwst", code: "MUM-WST-01", name: "Mumbai West Hub", city: "Mumbai" },
      { id: "node_blrsth", code: "BLR-STH-01", name: "Bengaluru South Hub", city: "Bengaluru" },
      { id: "node_hydcen", code: "HYD-CEN-01", name: "Hyderabad Central Hub", city: "Hyderabad" },
      { id: "node_punest", code: "PUN-EST-01", name: "Pune East Hub", city: "Pune" },
      { id: "node_chnnth", code: "CHN-NTH-01", name: "Chennai North Hub", city: "Chennai" },
    ],
  });

  // ─── Products ───────────────────────────────────────────────────────────

  await prisma.product.createMany({
    data: [
      { id: "prod_earbuds", sku: "SKU-EARBUD-01", name: "Wireless Earbuds Pro", category: "Electronics" },
      { id: "prod_cola", sku: "SKU-COLA-500", name: "Cola 500ml (Pack of 24)", category: "Beverages" },
      { id: "prod_oliveoil", sku: "SKU-OLIVE-01", name: "Extra Virgin Olive Oil 1L", category: "Grocery" },
      { id: "prod_protein", sku: "SKU-PROTEIN-01", name: "Whey Protein 1kg", category: "Health" },
      { id: "prod_toothpaste", sku: "SKU-TOOTH-01", name: "Toothpaste 150g", category: "Personal Care" },
      { id: "prod_battery", sku: "SKU-BATTERY-01", name: "AA Batteries (Pack of 8)", category: "Household" },
    ],
  });

  // ─── Suppliers ──────────────────────────────────────────────────────────

  await prisma.supplier.createMany({
    data: [
      { id: "sup_meridian", name: "Meridian Distributors", reliabilityScore: 0.92 },
      { id: "sup_kavery", name: "Kavery Wholesale", reliabilityScore: 0.88 },
      { id: "sup_northpoint", name: "Northpoint Supply Co", reliabilityScore: 0.71 },
    ],
  });

  // ─── Supplier terms ─────────────────────────────────────────────────────

  await prisma.supplierTerm.createMany({
    data: [
      // S1-A
      { supplierId: "sup_meridian", productId: "prod_earbuds", unitPrice: 450, moq: 100, lotSize: 50, leadTimeDays: 2 },
      // S1-B
      { supplierId: "sup_meridian", productId: "prod_cola", unitPrice: 620, moq: 50, lotSize: 25, leadTimeDays: 4 },
      // S1-C
      { supplierId: "sup_kavery", productId: "prod_oliveoil", unitPrice: 890, moq: 500, lotSize: 10, leadTimeDays: 8 },
      // S1-D
      { supplierId: "sup_meridian", productId: "prod_protein", unitPrice: 1200, moq: 50, lotSize: 25, leadTimeDays: 7 },
      // S1-E
      { supplierId: "sup_kavery", productId: "prod_toothpaste", unitPrice: 200, moq: 100, lotSize: 50, leadTimeDays: 2 },

      // S2-A — three suppliers for the same product.
      // Meridian holds the original PO. Northpoint is FASTEST but its MOQ of 800
      // cannot be reached inside storage headroom, so the agent must skip it and
      // land on Kavery. This is what stops the alternate-supplier search from
      // being a trivial "pick the first one" lookup.
      { supplierId: "sup_meridian", productId: "prod_battery", unitPrice: 480, moq: 250, lotSize: 50, leadTimeDays: 6 },
      { supplierId: "sup_northpoint", productId: "prod_battery", unitPrice: 610, moq: 800, lotSize: 100, leadTimeDays: 5 },
      { supplierId: "sup_kavery", productId: "prod_battery", unitPrice: 520, moq: 200, lotSize: 50, leadTimeDays: 9 },
    ],
  });

  // ─── S1-A — MODIFY (flagship) ───────────────────────────────────────────
  //
  //   available        = 120 - 20                 = 100
  //   demand           = 500 + 50                 = 550
  //   incoming         = 100 (OPEN PO, day 5)     = 100
  //   netRequirement   = 550 - 100 - 100          = 350
  //   headroomStorage  = 500 - 120 - 100          = 280
  //   headroomBudget   = floor(200000 / 450)      = 444
  //   qty              = roundDownToLot(280, 50)  = 250
  //   recommended 800 != 250                      -> MODIFY 250, binding STORAGE
  //
  //   Evidence gate: runRate7d = 500 * 7/14 = 250; actual 245 -> 2% divergence. Passes.
  //   Urgency: daysToStockout = 100 / (550/14) = 2.5; leadTime 2 <= 2.5. Not urgent.
  //
  //   budgetTotal 245000 - budgetUsed 45000 (the open PO: 100 x 450) = 200000 remaining.

  await prisma.inventory.create({
    data: { productId: "prod_earbuds", nodeId: "node_delncr", onHand: 120, reserved: 20 },
  });
  await prisma.demandForecast.create({
    data: {
      productId: "prod_earbuds",
      nodeId: "node_delncr",
      horizonDays: 14,
      forecastUnits: 500,
      safetyStock: 50,
      actualLast7d: 245,
      updatedAt: daysAgo(2),
    },
  });
  await prisma.nodeConstraint.create({
    data: { nodeId: "node_delncr", budgetTotal: 245000, budgetUsed: 45000, storageCapacity: 500, storageUsed: 120 },
  });
  await prisma.purchaseOrder.create({
    data: {
      id: "po_s1a_open",
      productId: "prod_earbuds",
      nodeId: "node_delncr",
      supplierId: "sup_meridian",
      quantity: 100,
      unitPrice: 450,
      status: PoStatus.OPEN,
      expectedDate: daysFromNow(5),
      idempotencyKey: "seed-s1a-open",
    },
  });
  await prisma.recommendation.create({
    data: {
      id: "rec_s1a",
      scenarioKey: "S1-A",
      productId: "prod_earbuds",
      nodeId: "node_delncr",
      recommendedQty: 800,
    },
  });

  // ─── S1-B — REJECT (demand already covered) ─────────────────────────────
  //
  //   available      = 430 - 30        = 400
  //   demand         = 300 + 30        = 330
  //   incoming       = 0
  //   netRequirement = max(0, 330-400) = 0  -> REJECT, binding DEMAND
  //
  //   Evidence gate: runRate7d = 150; actual 142 -> 5% divergence. Passes.

  await prisma.inventory.create({
    data: { productId: "prod_cola", nodeId: "node_mumwst", onHand: 430, reserved: 30 },
  });
  await prisma.demandForecast.create({
    data: {
      productId: "prod_cola",
      nodeId: "node_mumwst",
      horizonDays: 14,
      forecastUnits: 300,
      safetyStock: 30,
      actualLast7d: 142,
      updatedAt: daysAgo(3),
    },
  });
  await prisma.nodeConstraint.create({
    data: { nodeId: "node_mumwst", budgetTotal: 150000, budgetUsed: 0, storageCapacity: 900, storageUsed: 430 },
  });
  await prisma.recommendation.create({
    data: {
      id: "rec_s1b",
      scenarioKey: "S1-B",
      productId: "prod_cola",
      nodeId: "node_mumwst",
      recommendedQty: 800,
    },
  });

  // ─── S1-C — REJECT (MOQ unreachable) ────────────────────────────────────
  //
  //   available        = 200 - 0                  = 200
  //   demand           = 240 + 20                 = 260
  //   netRequirement   = 260 - 200 - 0            = 60
  //   qty              = roundUpToLot(60, 10) = 60; 60 < moq 500 -> qty = 500
  //   headroomStorage  = 300 - 200 - 0            = 100
  //   headroomBudget   = floor(500000 / 890)      = 561
  //   qty              = roundDownToLot(100, 10)  = 100
  //   100 < moq 500                               -> REJECT + escalate, binding MOQ
  //
  //   Evidence gate: runRate7d = 120; actual 115 -> 4% divergence. Passes.
  //   Urgency: daysToStockout = 200 / (260/14) = 10.8; leadTime 8 <= 10.8. Not urgent.

  await prisma.inventory.create({
    data: { productId: "prod_oliveoil", nodeId: "node_blrsth", onHand: 200, reserved: 0 },
  });
  await prisma.demandForecast.create({
    data: {
      productId: "prod_oliveoil",
      nodeId: "node_blrsth",
      horizonDays: 14,
      forecastUnits: 240,
      safetyStock: 20,
      actualLast7d: 115,
      updatedAt: daysAgo(4),
    },
  });
  await prisma.nodeConstraint.create({
    data: { nodeId: "node_blrsth", budgetTotal: 500000, budgetUsed: 0, storageCapacity: 300, storageUsed: 200 },
  });
  await prisma.recommendation.create({
    data: {
      id: "rec_s1c",
      scenarioKey: "S1-C",
      productId: "prod_oliveoil",
      nodeId: "node_blrsth",
      recommendedQty: 500,
    },
  });

  // ─── S1-D — INVESTIGATE (stale + contradicted evidence) ─────────────────
  //
  //   Both evidence-gate conditions fire:
  //     forecast.updatedAt is 21 days old (> 14 day limit)
  //     runRate7d = 400 * 7/14 = 200; actual 320 -> 60% divergence (> 30% limit)
  //
  //   -> INVESTIGATE, binding EVIDENCE, no quantity proposed.
  //   The §3 arithmetic is never reached.

  await prisma.inventory.create({
    data: { productId: "prod_protein", nodeId: "node_hydcen", onHand: 180, reserved: 0 },
  });
  await prisma.demandForecast.create({
    data: {
      productId: "prod_protein",
      nodeId: "node_hydcen",
      horizonDays: 14,
      forecastUnits: 400,
      safetyStock: 40,
      actualLast7d: 320,
      updatedAt: daysAgo(21),
    },
  });
  await prisma.nodeConstraint.create({
    data: { nodeId: "node_hydcen", budgetTotal: 400000, budgetUsed: 0, storageCapacity: 700, storageUsed: 180 },
  });
  await prisma.recommendation.create({
    data: {
      id: "rec_s1d",
      scenarioKey: "S1-D",
      productId: "prod_protein",
      nodeId: "node_hydcen",
      recommendedQty: 300,
    },
  });

  // ─── S1-E — ACCEPT ──────────────────────────────────────────────────────
  //
  //   available        = 110 - 10                 = 100
  //   demand           = 450 + 50                 = 500
  //   netRequirement   = 500 - 100 - 0            = 400
  //   headroomStorage  = 800 - 100 - 0            = 700
  //   headroomBudget   = floor(100000 / 200)      = 500
  //   qty              = roundDownToLot(400, 50)  = 400
  //   recommended 400 == 400                      -> ACCEPT, binding DEMAND
  //
  //   Evidence gate: runRate7d = 225; actual 232 -> 3% divergence. Passes.
  //   Urgency: daysToStockout = 100 / (500/14) = 2.8; leadTime 2 <= 2.8. Not urgent.

  await prisma.inventory.create({
    data: { productId: "prod_toothpaste", nodeId: "node_punest", onHand: 110, reserved: 10 },
  });
  await prisma.demandForecast.create({
    data: {
      productId: "prod_toothpaste",
      nodeId: "node_punest",
      horizonDays: 14,
      forecastUnits: 450,
      safetyStock: 50,
      actualLast7d: 232,
      updatedAt: daysAgo(1),
    },
  });
  await prisma.nodeConstraint.create({
    data: { nodeId: "node_punest", budgetTotal: 100000, budgetUsed: 0, storageCapacity: 800, storageUsed: 100 },
  });
  await prisma.recommendation.create({
    data: {
      id: "rec_s1e",
      scenarioKey: "S1-E",
      productId: "prod_toothpaste",
      nodeId: "node_punest",
      recommendedQty: 400,
    },
  });

  // ─── S2-A — Partial fulfilment ──────────────────────────────────────────
  //
  //   Original PO: 500 units from Meridian @ 480, supplier confirms only 250.
  //
  //   available       = 1960 - 60                      = 1900
  //   demand          = 2350 + 50                      = 2400
  //   incoming        = 250 (confirmedQty, NOT the ordered 500)
  //   remainingNeed   = 2400 - 1900 - 250              = 250
  //   dailyDemand     = 2400 / 14                      = 171.43
  //   daysToStockout  = 1900 / 171.43                  = 11.08
  //   headroomStorage = 2600 - 1960 - 250              = 390
  //
  //   Alternate suppliers, ascending by leadTimeDays:
  //     Northpoint (5d, moq 800, lot 100, 610):
  //       qty -> 800; capped to roundDownToLot(min(800, 390), 100) = 300
  //       300 < moq 800  -> DISQUALIFIED
  //     Kavery (9d, moq 200, lot 50, 520):
  //       qty = roundUpToLot(250, 50) = 250; 250 >= moq 200
  //       headroomBudget = floor(400000 / 520) = 769
  //       qty = roundDownToLot(min(250, 390, 769), 50) = 250
  //       leadTime 9 <= 11.08  -> QUALIFIED
  //
  //   -> CREATE_SUPPLEMENTARY_PO, Kavery, 250 units, cost 130000.
  //
  //   Evidence gate: runRate7d = 1175; actual 1210 -> 3% divergence. Passes.
  //   budgetTotal 640000 - budgetUsed 240000 (original PO: 500 x 480) = 400000.

  await prisma.inventory.create({
    data: { productId: "prod_battery", nodeId: "node_chnnth", onHand: 1960, reserved: 60 },
  });
  await prisma.demandForecast.create({
    data: {
      productId: "prod_battery",
      nodeId: "node_chnnth",
      horizonDays: 14,
      forecastUnits: 2350,
      safetyStock: 50,
      actualLast7d: 1210,
      updatedAt: daysAgo(2),
    },
  });
  await prisma.nodeConstraint.create({
    data: { nodeId: "node_chnnth", budgetTotal: 640000, budgetUsed: 240000, storageCapacity: 2600, storageUsed: 1960 },
  });
  await prisma.purchaseOrder.create({
    data: {
      id: "po_s2a_partial",
      productId: "prod_battery",
      nodeId: "node_chnnth",
      supplierId: "sup_meridian",
      quantity: 500,
      confirmedQty: 250,
      unitPrice: 480,
      status: PoStatus.PARTIAL,
      expectedDate: daysFromNow(6),
      idempotencyKey: "seed-s2a-partial",
    },
  });

  // ─── Summary ────────────────────────────────────────────────────────────

  const counts = {
    nodes: await prisma.node.count(),
    products: await prisma.product.count(),
    suppliers: await prisma.supplier.count(),
    supplierTerms: await prisma.supplierTerm.count(),
    inventory: await prisma.inventory.count(),
    forecasts: await prisma.demandForecast.count(),
    constraints: await prisma.nodeConstraint.count(),
    purchaseOrders: await prisma.purchaseOrder.count(),
    recommendations: await prisma.recommendation.count(),
  };

  console.log("\nSeed complete.");
  console.table(counts);
  console.log("\nScenarios ready:");
  console.log("  S1-A  MODIFY 250        Wireless Earbuds Pro @ Delhi NCR      (rec 800, storage-capped)");
  console.log("  S1-B  REJECT            Cola 500ml @ Mumbai West              (rec 800, demand covered)");
  console.log("  S1-C  REJECT + escalate Olive Oil 1L @ Bengaluru South        (rec 500, MOQ unreachable)");
  console.log("  S1-D  INVESTIGATE       Whey Protein 1kg @ Hyderabad Central  (rec 300, stale forecast)");
  console.log("  S1-E  ACCEPT 400        Toothpaste 150g @ Pune East           (rec 400, matches)");
  console.log("  S2-A  SUPPLEMENTARY PO  AA Batteries @ Chennai North          (500 ordered, 250 confirmed)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });