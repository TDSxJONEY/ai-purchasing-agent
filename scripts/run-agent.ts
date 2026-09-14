import "dotenv/config";
import { prisma } from "../src/lib/db";
import { createRun, runToCompletion } from "../src/agent/loop";
import { framePurchaseReview, frameSupplierShortfall } from "../src/agent/prompt";
import { startRecording } from "../src/agent/replay";
import {
  decidePurchase,
  decidePartialFulfilment,
  type SupplierTerms,
} from "../src/domain/rules";
import { loadSituation } from "../src/domain/state";

/**
 * CLI driver — the agent outside Next.js entirely.
 *
 * Running here rather than through an HTTP route means a malformed tool call
 * shows up as a stack trace in a terminal instead of a 500 in a network tab.
 *
 * It also grades each run against the deterministic rules engine, which is the
 * ground truth the evaluation suite uses. This is the eval harness in miniature.
 *
 * Usage:
 *   npm run agent S1-A
 *   npm run agent S1-A -- --record
 *   npm run agent S1-A -- --replay
 *   npm run agent -- --all --record
 *   npm run agent S1-A -- --model nvidia/nemotron-3-super-120b-a12b:free
 */

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

const ALL_SCENARIOS = ["S1-A", "S1-B", "S1-C", "S1-D", "S1-E", "S2-A"];

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

interface Grade {
  field: string;
  expected: string;
  actual: string;
  ok: boolean;
}

async function gradePurchase(
  recommendationId: string,
  decision: { decision: string; quantity: number | null; bindingConstraint: string }
): Promise<{ grades: Grade[]; reference: string } | null> {
  const s = await loadSituation(recommendationId);
  if (!s) return null;

  const term = await prisma.supplierTerm.findFirst({
    where: { productId: s.productId },
    include: { supplier: true },
    orderBy: { leadTimeDays: "asc" },
  });
  if (!term) return null;

  const supplier: SupplierTerms = {
    supplierId: term.supplierId,
    supplierName: term.supplier.name,
    unitPrice: term.unitPrice,
    moq: term.moq,
    lotSize: term.lotSize,
    leadTimeDays: term.leadTimeDays,
  };

  const truth = decidePurchase({
    recommendedQty: s.recommendedQty,
    onHand: s.onHand,
    reserved: s.reserved,
    horizonDays: s.horizonDays,
    forecastUnits: s.forecastUnits,
    safetyStock: s.safetyStock,
    actualLast7d: s.actualLast7d,
    forecastUpdatedAt: s.forecastUpdatedAt,
    incoming: s.incoming,
    budgetTotal: s.budgetTotal,
    budgetUsed: s.budgetUsed,
    storageCapacity: s.storageCapacity,
    storageUsed: s.storageUsed,
    supplier,
  });

  return {
    grades: [
      {
        field: "decision",
        expected: truth.decision,
        actual: decision.decision,
        ok: truth.decision === decision.decision,
      },
      {
        field: "quantity",
        expected: String(truth.quantity ?? 0),
        actual: String(decision.quantity ?? 0),
        ok: (truth.quantity ?? 0) === (decision.quantity ?? 0),
      },
      {
        field: "constraint",
        expected: truth.bindingConstraint,
        actual: decision.bindingConstraint,
        ok: truth.bindingConstraint === decision.bindingConstraint,
      },
    ],
    reference: truth.reason,
  };
}

async function gradeShortfall(decision: {
  decision: string;
  quantity: number | null;
  supplierId: string | null;
}): Promise<{ grades: Grade[]; reference: string } | null> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: "po_s2a_partial" },
  });
  if (!po) return null;

  const [inv, forecast, constraint, terms] = await Promise.all([
    prisma.inventory.findUnique({
      where: { productId_nodeId: { productId: po.productId, nodeId: po.nodeId } },
    }),
    prisma.demandForecast.findUnique({
      where: { productId_nodeId: { productId: po.productId, nodeId: po.nodeId } },
    }),
    prisma.nodeConstraint.findUnique({ where: { nodeId: po.nodeId } }),
    prisma.supplierTerm.findMany({
      where: { productId: po.productId, supplierId: { not: po.supplierId } },
      include: { supplier: true },
    }),
  ]);

  if (!inv || !forecast || !constraint) return null;

  const truth = decidePartialFulfilment({
    orderedQty: po.quantity,
    confirmedQty: po.confirmedQty ?? 0,
    onHand: inv.onHand,
    reserved: inv.reserved,
    horizonDays: forecast.horizonDays,
    forecastUnits: forecast.forecastUnits,
    safetyStock: forecast.safetyStock,
    actualLast7d: forecast.actualLast7d,
    forecastUpdatedAt: forecast.updatedAt,
    otherIncoming: 0,
    budgetTotal: constraint.budgetTotal,
    budgetUsed: constraint.budgetUsed,
    storageCapacity: constraint.storageCapacity,
    storageUsed: constraint.storageUsed,
    alternates: terms.map((t) => ({
      supplierId: t.supplierId,
      supplierName: t.supplier.name,
      unitPrice: t.unitPrice,
      moq: t.moq,
      lotSize: t.lotSize,
      leadTimeDays: t.leadTimeDays,
    })),
  });

  return {
    grades: [
      {
        field: "outcome",
        expected: truth.outcome,
        actual: decision.decision,
        ok: truth.outcome === decision.decision,
      },
      {
        field: "quantity",
        expected: String(truth.quantity),
        actual: String(decision.quantity ?? 0),
        ok: truth.quantity === (decision.quantity ?? 0),
      },
      {
        field: "supplier",
        expected: truth.chosenSupplier?.supplierId ?? "(none)",
        actual: decision.supplierId ?? "(none)",
        ok: (truth.chosenSupplier?.supplierId ?? null) === decision.supplierId,
      },
    ],
    reference: truth.reason,
  };
}

async function runScenario(
  scenarioKey: string,
  opts: { model?: string; mode: string; record: boolean; quiet: boolean }
): Promise<{ scenarioKey: string; grades: Grade[]; failed: boolean }> {
  let userMessage: string;
  let recommendationId: string | null = null;
  let triggerPoId: string | null = null;

  if (scenarioKey === "S2-A") {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: "po_s2a_partial" },
      include: { product: true, node: true, supplier: true },
    });
    if (!po) throw new Error("S2-A purchase order missing. Run: npm run db:seed");

    triggerPoId = po.id;
    userMessage = frameSupplierShortfall({
      purchaseOrderId: po.id,
      productId: po.productId,
      productName: po.product.name,
      nodeId: po.nodeId,
      nodeName: po.node.name,
      supplierName: po.supplier.name,
      orderedQty: po.quantity,
      confirmedQty: po.confirmedQty ?? 0,
    });
  } else {
    const rec = await prisma.recommendation.findUnique({
      where: { scenarioKey },
      include: { product: true, node: true },
    });
    if (!rec) throw new Error(`No recommendation "${scenarioKey}". Run: npm run db:seed`);

    recommendationId = rec.id;
    userMessage = framePurchaseReview({
      scenarioKey,
      productId: rec.productId,
      productName: rec.product.name,
      productSku: rec.product.sku,
      nodeId: rec.nodeId,
      nodeCode: rec.node.code,
      nodeName: rec.node.name,
      recommendedQty: rec.recommendedQty,
    });
  }

  if (opts.record) {
    startRecording(scenarioKey, opts.model ?? process.env.OPENROUTER_MODEL ?? "unknown");
  }

  const run = await createRun({
    scenarioKey,
    recommendationId,
    triggerPoId,
    userMessage,
    mode: opts.mode,
  });

  const started = Date.now();

  await runToCompletion(run.id, {
    model: opts.model,
    mode: opts.mode,
    record: opts.record,
    onStep: (o) => {
      if (opts.quiet) return;
      const label = `${CYAN}Step ${o.stepIndex + 1}${RESET}`;
      if (o.error) {
        console.log(`${label}  ${RED}ERROR${RESET}  ${o.error}`);
        return;
      }
      if (o.assistantText) {
        console.log(`${label}  ${DIM}${o.assistantText.slice(0, 300).replace(/\n+/g, " ")}${RESET}`);
      }
      if (o.toolsCalled.length > 0) {
        console.log(`${label}  called: ${o.toolsCalled.join(", ")}`);
      }
    },
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const decision = await prisma.agentDecision.findUnique({ where: { runId: run.id } });
  const finalRun = await prisma.agentRun.findUnique({ where: { id: run.id } });

  if (!decision) {
    console.log(`\n${RED}${scenarioKey}: no decision submitted${RESET}  (${finalRun?.status})`);
    if (finalRun?.error) console.log(`  ${finalRun.error}`);
    return { scenarioKey, grades: [], failed: true };
  }

  if (!opts.quiet) {
    console.log(`\n${DIM}${"-".repeat(70)}${RESET}`);
    console.log(`${BOLD}Result${RESET}  ${DIM}(${elapsed}s, ${finalRun?.stepCount} steps, ${opts.mode})${RESET}\n`);
    console.log(`  Decision:   ${BOLD}${decision.decision}${RESET}`);
    console.log(`  Quantity:   ${decision.quantity}`);
    console.log(`  Constraint: ${decision.bindingConstraint}`);
    console.log(`  Urgent:     ${decision.urgent} ${DIM}(not graded)${RESET}`);
    console.log(`  Supplier:   ${decision.supplierId ?? "(none)"}`);
    console.log(`\n  ${decision.rationale}\n`);
    const factors = Array.isArray(decision.factors) ? decision.factors : [];
    for (const f of factors) console.log(`    - ${f}`);
  }

  const graded =
    scenarioKey === "S2-A"
      ? await gradeShortfall(decision)
      : recommendationId
        ? await gradePurchase(recommendationId, decision)
        : null;

  if (!graded) return { scenarioKey, grades: [], failed: false };

  if (!opts.quiet) {
    console.log(`\n${DIM}${"-".repeat(70)}${RESET}`);
    console.log(`${BOLD}Graded against the deterministic rules engine${RESET}\n`);
    for (const g of graded.grades) {
      const mark = g.ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
      console.log(`  ${mark}  ${g.field.padEnd(10)} expected ${g.expected}, got ${g.actual}`);
    }
    console.log(`\n${DIM}  Reference: ${graded.reference}${RESET}`);
  }

  return {
    scenarioKey,
    grades: graded.grades,
    failed: graded.grades.some((g) => !g.ok),
  };
}

async function main() {
  const model = value("--model");
  const record = flag("--record");
  const mode = flag("--replay") ? "replay" : "live";
  const all = flag("--all");

  if (record && mode === "replay") {
    console.error("--record and --replay cannot be combined.");
    process.exit(1);
  }

  const positional = argv.find((a) => !a.startsWith("--") && a !== model);
  const scenarios = all ? ALL_SCENARIOS : positional ? [positional] : [];

  if (scenarios.length === 0) {
    console.error(
      `Usage: npm run agent <${ALL_SCENARIOS.join("|")}> [-- --record|--replay|--model id]\n` +
        `       npm run agent -- --all --record`
    );
    process.exit(1);
  }

  console.log(`${DIM}Mode: ${mode}${record ? " (recording)" : ""}   Model: ${model ?? process.env.OPENROUTER_MODEL}${RESET}\n`);

  const results = [];

  for (const scenarioKey of scenarios) {
    if (all) console.log(`\n${BOLD}${"=".repeat(70)}\n${scenarioKey}\n${"=".repeat(70)}${RESET}\n`);
    else console.log(`${BOLD}Scenario ${scenarioKey}${RESET}\n`);

    results.push(await runScenario(scenarioKey, { model, mode, record, quiet: false }));

    // Free tiers rate-limit on sustained bursts. Space out batch runs.
    if (all && mode === "live" && scenarioKey !== ALL_SCENARIOS.at(-1)) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  if (results.length > 1) {
    console.log(`\n${BOLD}${"=".repeat(70)}\nSummary\n${"=".repeat(70)}${RESET}\n`);
    for (const r of results) {
      const passed = r.grades.filter((g) => g.ok).length;
      const total = r.grades.length;
      const colour = r.failed ? RED : total === 0 ? YELLOW : GREEN;
      console.log(`  ${colour}${r.scenarioKey.padEnd(8)}${RESET} ${passed}/${total} checks`);
    }
  }

  await prisma.$disconnect();
  process.exit(results.some((r) => r.failed) ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});