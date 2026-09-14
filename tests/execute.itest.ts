import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { PoStatus, RunStatus } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { executePurchase } from "../src/domain/execute";
import {
  computeIncoming,
  computeCommittedSpend,
  loadSituation,
  simulateConcurrentSpend,
} from "../src/domain/state";

/**
 * Integration suite — hits the real database.
 *
 * Skipped automatically when DATABASE_URL is absent, so CI stays green without
 * credentials. Reseeds before and after, which means running it wipes local
 * demo state. That trade is deliberate: determinism beats convenience here.
 *
 * NOTE ON ISOLATION: these tests share one database and run in file order, so a
 * test that writes a purchase order changes what later tests see. Each case
 * below therefore targets a node no earlier case has touched, or reseeds first.
 * Where a test needs an exact starting balance, it reseeds — asserting absolute
 * figures against inherited state is how this suite broke the first time.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

function reseed() {
  execSync("npm run db:seed", { stdio: "ignore" });
}

async function makeRun(scenarioKey: string, recommendationId: string | null) {
  return prisma.agentRun.create({
    data: {
      scenarioKey,
      recommendationId,
      status: RunStatus.AWAITING_APPROVAL,
      mode: "test",
    },
  });
}

describe.skipIf(!hasDb)("execution and validation against live state", () => {
  beforeAll(() => reseed(), 180_000);
  afterAll(async () => {
    reseed();
    await prisma.$disconnect();
  }, 180_000);

  it("the seed satisfies the budgetUsed invariant", async () => {
    for (const nodeId of ["node_delncr", "node_chnnth", "node_mumwst"]) {
      const stored = await prisma.nodeConstraint.findUnique({ where: { nodeId } });
      const derived = await computeCommittedSpend(nodeId);
      expect(stored?.budgetUsed).toBe(derived);
    }
  });

  it("counts only the confirmed quantity of a partial order as incoming", async () => {
    // S2-A: ordered 500, confirmed 250.
    const incoming = await computeIncoming("prod_battery", "node_chnnth");
    expect(incoming).toBe(250);
  });

  it("loads S1-A matching the spec's hand-derived figures", async () => {
    const s = await loadSituation("rec_s1a");
    expect(s?.available).toBe(100);
    expect(s?.incoming).toBe(100);
    expect(s?.forecastUnits).toBe(500);
    expect(s?.storageCapacity).toBe(500);
    expect(s?.budgetUsed).toBe(45_000);
  });

  it("executes the correct S1-A order and validates it", async () => {
    const run = await makeRun("S1-A", "rec_s1a");

    const result = await executePurchase({
      runId: run.id,
      productId: "prod_earbuds",
      nodeId: "node_delncr",
      supplierId: "sup_meridian",
      quantity: 250,
      idempotencyKey: `test-s1a-${run.id}`,
      agentStatedQuantity: 250,
    });

    expect(result.validation.passed).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(result.po.status).toBe(PoStatus.OPEN);
    expect(result.po.unitPrice).toBe(450);

    // Budget debited: 45,000 + 250 x 450 = 157,500
    const constraint = await prisma.nodeConstraint.findUnique({
      where: { nodeId: "node_delncr" },
    });
    expect(constraint?.budgetUsed).toBe(157_500);

    const refreshed = await prisma.agentRun.findUnique({ where: { id: run.id } });
    expect(refreshed?.status).toBe(RunStatus.VALIDATED);

    // Invariant still holds after the write.
    expect(await computeCommittedSpend("node_delncr")).toBe(157_500);
  });

  it("returns the original order when the same approval is submitted twice", async () => {
    const run = await makeRun("S1-E", "rec_s1e");
    const key = `test-idem-${run.id}`;

    const first = await executePurchase({
      runId: run.id,
      productId: "prod_toothpaste",
      nodeId: "node_punest",
      supplierId: "sup_kavery",
      quantity: 400,
      idempotencyKey: key,
      agentStatedQuantity: 400,
    });

    const second = await executePurchase({
      runId: run.id,
      productId: "prod_toothpaste",
      nodeId: "node_punest",
      supplierId: "sup_kavery",
      quantity: 400,
      idempotencyKey: key,
      agentStatedQuantity: 400,
    });

    expect(second.reused).toBe(true);
    expect(second.po.id).toBe(first.po.id);

    const count = await prisma.purchaseOrder.count({
      where: { productId: "prod_toothpaste", nodeId: "node_punest" },
    });
    expect(count).toBe(1);

    // Budget debited once, not twice.
    const constraint = await prisma.nodeConstraint.findUnique({
      where: { nodeId: "node_punest" },
    });
    expect(constraint?.budgetUsed).toBe(80_000);
  });

  it("rolls back an order that breaks the lot size", async () => {
    // Hyderabad / whey protein: untouched by earlier cases, so the figures below
    // are the seeded ones. 110 units isolates V3 and nothing else:
    //   V2 110 >= moq 50                                    pass
    //   V3 110 % lot 25 = 10                                FAIL
    //   V4 110 <= headroom 700 - 180 - 0 = 520              pass
    //   V5 110 x 1200 = 132,000 <= 400,000                  pass
    //   V6 180 + 0 + 110 = 290 <= ceiling floor(440 x 1.2)  pass
    const run = await makeRun("S1-D-badlot", "rec_s1d");

    const result = await executePurchase({
      runId: run.id,
      productId: "prod_protein",
      nodeId: "node_hydcen",
      supplierId: "sup_meridian",
      quantity: 110,
      idempotencyKey: `test-badlot-${run.id}`,
      agentStatedQuantity: 110,
    });

    expect(result.validation.passed).toBe(false);
    expect(result.validation.failedIds).toEqual(["V3"]);
    expect(result.rolledBack).toBe(true);
    expect(result.po.status).toBe(PoStatus.DRAFT);

    // A lot-size breach is a fixed ordering rule, not a timing problem, so the
    // brief must not tell the agent to go re-read state.
    expect(result.brief).toContain("structural");
    expect(result.brief).not.toContain("state-sensitive");

    // Budget fully restored.
    const constraint = await prisma.nodeConstraint.findUnique({
      where: { nodeId: "node_hydcen" },
    });
    expect(constraint?.budgetUsed).toBe(0);
  });

  it("rolls back when budget was consumed after the agent investigated", async () => {
    // The centrepiece: the agent's arithmetic was right, the world moved.
    // Reseeded first because this case asserts exact balances at Delhi-NCR,
    // which an earlier test in this file has already written to.
    reseed();

    const run = await makeRun("S1-A-drift", "rec_s1a");

    const before = await loadSituation("rec_s1a");
    expect(before?.budgetUsed).toBe(45_000); // agent sees 200,000 remaining

    // Another buyer commits 150,000 between investigation and approval.
    await simulateConcurrentSpend("node_delncr", 150_000);

    const result = await executePurchase({
      runId: run.id,
      productId: "prod_earbuds",
      nodeId: "node_delncr",
      supplierId: "sup_meridian",
      quantity: 250, // correct against the state the agent saw
      idempotencyKey: `test-drift-${run.id}`,
      agentStatedQuantity: 250,
    });

    expect(result.validation.passed).toBe(false);
    expect(result.validation.failedIds).toEqual(["V5"]);
    expect(result.rolledBack).toBe(true);
    expect(result.po.status).toBe(PoStatus.DRAFT);

    const refreshed = await prisma.agentRun.findUnique({ where: { id: run.id } });
    expect(refreshed?.status).toBe(RunStatus.VALIDATION_FAILED);

    // The brief tells the agent state moved, without telling it what to order.
    expect(result.brief).toContain("state-sensitive");
    expect(result.brief).toContain("do not reuse the earlier snapshot");

    // Budget restored to the drifted level, not the original.
    const constraint = await prisma.nodeConstraint.findUnique({
      where: { nodeId: "node_delncr" },
    });
    expect(constraint?.budgetUsed).toBe(195_000);
  });

  it("fails V8 when the supplier has no terms for the product", async () => {
    const run = await makeRun("S1-B-nosupplier", "rec_s1b");

    const result = await executePurchase({
      runId: run.id,
      productId: "prod_earbuds",
      nodeId: "node_delncr",
      supplierId: "sup_northpoint", // supplies batteries only
      quantity: 200,
      idempotencyKey: `test-nosup-${run.id}`,
      agentStatedQuantity: 200,
    });

    expect(result.validation.failedIds).toContain("V8");
    expect(result.rolledBack).toBe(true);
  });
});