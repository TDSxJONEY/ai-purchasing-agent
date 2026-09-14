import "dotenv/config";
import { prisma } from "../src/lib/db";
import { startScenarioRun } from "../src/agent/start";
import { runToCompletion } from "../src/agent/loop";
import { startRecording } from "../src/agent/replay";
import { gradeDecision } from "../src/agent/grade";
import { ALL_SCENARIOS } from "../src/domain/scenarios";

/**
 * CLI driver — the agent outside Next.js entirely.
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

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function runScenario(
  scenarioKey: string,
  opts: { model?: string; mode: string; record: boolean; quiet: boolean }
): Promise<{ scenarioKey: string; primaryFailed: boolean; passed: number; total: number }> {
  if (opts.record) {
    startRecording(scenarioKey, opts.model ?? process.env.OPENROUTER_MODEL ?? "unknown");
  }

  const run = await startScenarioRun(scenarioKey, opts.mode);
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
    return { scenarioKey, primaryFailed: true, passed: 0, total: 0 };
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

  const graded = await gradeDecision(scenarioKey, run.recommendationId, decision);

  if (!graded) return { scenarioKey, primaryFailed: false, passed: 0, total: 0 };

  if (!opts.quiet) {
    console.log(`\n${DIM}${"-".repeat(70)}${RESET}`);
    console.log(`${BOLD}Graded against the deterministic rules engine${RESET}\n`);
    for (const g of graded.checks) {
      const mark = g.ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
      const weight = g.weight === "secondary" ? `${DIM}(advisory)${RESET} ` : "";
      console.log(
        `  ${mark}  ${weight}${g.field.padEnd(10)} expected ${g.expected}, got ${g.actual}`
      );
    }
    console.log(`\n${DIM}  Reference: ${graded.reference}${RESET}`);
  }

  return {
    scenarioKey,
    primaryFailed: !graded.passed,
    passed: graded.primaryPassed,
    total: graded.primaryTotal,
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
  const scenarios = all ? [...ALL_SCENARIOS] : positional ? [positional] : [];

  if (scenarios.length === 0) {
    console.error(
      `Usage: npm run agent <${ALL_SCENARIOS.join("|")}> [-- --record|--replay|--model id]\n` +
        `       npm run agent -- --all --record`
    );
    process.exit(1);
  }

  console.log(
    `${DIM}Mode: ${mode}${record ? " (recording)" : ""}   Model: ${model ?? process.env.OPENROUTER_MODEL}${RESET}\n`
  );

  const results = [];

  for (const scenarioKey of scenarios) {
    if (all) console.log(`\n${BOLD}${"=".repeat(70)}\n${scenarioKey}\n${"=".repeat(70)}${RESET}\n`);
    else console.log(`${BOLD}Scenario ${scenarioKey}${RESET}\n`);

    results.push(await runScenario(scenarioKey, { model, mode, record, quiet: false }));

    if (all && mode === "live" && scenarioKey !== ALL_SCENARIOS.at(-1)) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  if (results.length > 1) {
    console.log(`\n${BOLD}${"=".repeat(70)}\nSummary\n${"=".repeat(70)}${RESET}\n`);
    for (const r of results) {
      const colour = r.primaryFailed ? RED : r.total === 0 ? YELLOW : GREEN;
      console.log(`  ${colour}${r.scenarioKey.padEnd(8)}${RESET} ${r.passed}/${r.total} primary checks`);
    }
  }

  await prisma.$disconnect();
  process.exit(results.some((r) => r.primaryFailed) ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
