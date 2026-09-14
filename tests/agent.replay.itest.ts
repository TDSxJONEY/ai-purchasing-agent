import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PoStatus, RunStatus } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { seedDatabase } from "../src/lib/seed";
import { createRun, runToCompletion } from "../src/agent/loop";
import { startScenarioRun, startReinvestigation } from "../src/agent/start";
import { gradeDecision } from "../src/agent/grade";
import { executePurchase } from "../src/domain/execute";
import { simulateConcurrentSpend } from "../src/domain/state";
import { buildReinvestigationBrief } from "../src/domain/validate";
import { ALL_SCENARIOS } from "../src/domain/scenarios";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("replay evaluation against live tools and database", () => {
  beforeAll(async () => {
    await seedDatabase();
  }, 180_000);

  afterAll(async () => {
    await seedDatabase();
    await prisma.$disconnect();
  }, 180_000);

  for (const scenarioKey of ALL_SCENARIOS) {
    it(`replays ${scenarioKey} to the correct decision`, async () => {
      const run = await startScenarioRun(scenarioKey, "replay");
      const outcome = await runToCompletion(run.id, { mode: "replay" });
      expect(outcome.finished).toBe(true);

      const steps = await prisma.agentStep.findMany({ where: { runId: run.id } });
      const tools = steps.filter((s) => s.type === "tool");
      expect(tools.length).toBeGreaterThan(0);

      const unrecovered = tools.filter((s) => {
        const payload = s.payload as { ok?: boolean; result?: { error?: string } };
        return payload.ok === false && payload.result?.error;
      });
      expect(unrecovered).toEqual([]);

      const needed = ["get_inventory", "get_demand_forecast", "get_supplier_terms", "get_node_constraints"];
      const names = tools.map((s) => s.name);
      for (const name of needed) {
        expect(names).toContain(name);
      }

      const decision = await prisma.agentDecision.findUnique({ where: { runId: run.id } });
      expect(decision).not.toBeNull();

      const grade = await gradeDecision(scenarioKey, run.recommendationId, {
        decision: decision!.decision,
        quantity: decision!.quantity,
        bindingConstraint: decision!.bindingConstraint,
        supplierId: decision!.supplierId,
      });
      expect(grade?.passed).toBe(true);

      if (scenarioKey === "S1-D") {
        expect(decision!.decision).toBe("INVESTIGATE");
      }
    }, 60_000);
  }

  it("executes a correct S1-A decision and then fails validation after budget drift", async () => {
    await seedDatabase();
    const run = await startScenarioRun("S1-A", "replay");
    await runToCompletion(run.id, { mode: "replay" });
    const decision = await prisma.agentDecision.findUnique({ where: { runId: run.id } });
    expect(decision?.decision).toBe("MODIFY");
    expect(decision?.quantity).toBe(250);

    const ok = await executePurchase({
      runId: run.id,
      productId: "prod_earbuds",
      nodeId: "node_delncr",
      supplierId: "sup_meridian",
      quantity: 250,
      idempotencyKey: `replay-s1a-${run.id}`,
      agentStatedQuantity: 250,
    });
    expect(ok.validation.passed).toBe(true);
    expect(ok.po.status).toBe(PoStatus.OPEN);

    await seedDatabase();
    const drifted = await prisma.agentRun.create({
      data: {
        scenarioKey: "S1-A",
        recommendationId: "rec_s1a",
        status: RunStatus.AWAITING_APPROVAL,
        mode: "replay",
      },
    });
    await simulateConcurrentSpend("node_delncr", 150_000);
    const failed = await executePurchase({
      runId: drifted.id,
      productId: "prod_earbuds",
      nodeId: "node_delncr",
      supplierId: "sup_meridian",
      quantity: 250,
      idempotencyKey: `replay-drift-${drifted.id}`,
      agentStatedQuantity: 250,
    });
    expect(failed.validation.failedIds).toEqual(["V5"]);
    expect(failed.rolledBack).toBe(true);
    expect(failed.po.status).toBe(PoStatus.DRAFT);

    const refreshed = await prisma.agentRun.findUnique({ where: { id: drifted.id } });
    expect(refreshed?.status).toBe(RunStatus.VALIDATION_FAILED);

    const brief = buildReinvestigationBrief(failed.validation, {
      poQuantity: 250,
      supplierName: "Meridian Distributors",
    });
    const second = await startReinvestigation(drifted.id, brief);
    const messages = second.messages as Array<{ role: string; content: string }>;
    expect(messages.some((m) => m.role === "user" && m.content.includes("state-sensitive"))).toBe(
      true
    );
    expect(messages.some((m) => /order \d+ units instead/i.test(m.content))).toBe(false);
  }, 120_000);

  it("createRun is the same entry used by the API loop", async () => {
    const run = await createRun({
      scenarioKey: "S1-E",
      recommendationId: "rec_s1e",
      userMessage: "fixture",
      mode: "replay",
    });
    expect(run.id).toBeTruthy();
  });
});
