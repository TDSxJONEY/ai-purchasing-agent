/**
 * Stepped agent loop.
 *
 * ONE LLM CALL PER INVOCATION. The full message array is persisted on the
 * AgentRun row and reloaded each time, so no agent state lives in process memory
 * between calls.
 *
 * This exists because serverless functions have a hard duration cap. A loop that
 * makes six sequential LLM calls inside one request will exceed it, and will do
 * so only after deployment, since it works fine locally. Stepping also gives the
 * UI a progressive trace to render instead of a spinner.
 *
 * Tool calls WITHIN a step run in parallel. The model is encouraged to request
 * several at once, which collapses a typical investigation into two or three LLM
 * calls rather than seven. On a rate-limited free tier that is the difference
 * between a usable demo and a 429.
 *
 * STEP INDEXING: AgentStep has a unique constraint on (runId, index). Each LLM
 * step owns a block of 100: the assistant record takes stepIndex * 100 and its
 * tool results take stepIndex * 100 + 1 upward. A flat index for the assistant
 * would collide with the previous step's first tool result.
 */

import { RunStatus, DecisionType, BindingConstraint } from "@prisma/client";
import { prisma } from "@/lib/db";
import { chatCompletion, type ChatMessage, type ChatResponse } from "@/lib/openrouter";
import { env } from "@/lib/env";
import { TOOLS, toolsForRequest, executeTool } from "./tools";
import { replayResponse, recordResponse } from "./replay";
import { SYSTEM_PROMPT } from "./prompt";

/** Safety ceiling. With parallel tool calls a run should finish in 2-4 steps. */
export const MAX_STEPS = 8;

/** Assistant and tool records for one LLM step share a block of this size. */
const STEP_INDEX_BLOCK = 100;

export interface StepOutcome {
  runId: string;
  stepIndex: number;
  status: RunStatus;
  /** True when the run reached a decision or gave up. */
  finished: boolean;
  toolsCalled: string[];
  assistantText: string | null;
  error: string | null;
}

export interface StepOptions {
  model?: string;
  /** Overrides the run's stored mode. "live" or "replay". */
  mode?: string;
  /** Write each live response to the scenario's fixture. */
  record?: boolean;
}

function asMessages(value: unknown): ChatMessage[] {
  return Array.isArray(value) ? (value as ChatMessage[]) : [];
}

function parseArguments(raw: string): {
  ok: boolean;
  args: Record<string, any>;
  error?: string;
} {
  if (!raw || raw.trim() === "") return { ok: true, args: {} };
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, args: {}, error: "Arguments must be a JSON object." };
    }
    return { ok: true, args: parsed };
  } catch {
    return {
      ok: false,
      args: {},
      error: `Arguments were not valid JSON. Received: ${raw.slice(0, 200)}`,
    };
  }
}

const DECISIONS = new Set<string>(Object.values(DecisionType));
const CONSTRAINTS = new Set<string>(Object.values(BindingConstraint));

/**
 * Advances a run by exactly one LLM call. Returns when the model has either
 * requested tools (executed and recorded) or submitted a decision.
 */
export async function stepRun(
  runId: string,
  options: StepOptions = {}
): Promise<StepOutcome> {
  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error(`Agent run ${runId} not found.`);

  if (run.status !== RunStatus.PENDING && run.status !== RunStatus.RUNNING) {
    return {
      runId,
      stepIndex: run.stepCount,
      status: run.status,
      finished: true,
      toolsCalled: [],
      assistantText: null,
      error: null,
    };
  }

  const messages = asMessages(run.messages);
  const stepIndex = run.stepCount;
  const base = stepIndex * STEP_INDEX_BLOCK;
  const mode = options.mode ?? run.mode ?? env.AGENT_MODE;

  if (stepIndex >= MAX_STEPS) {
    const error = `Exceeded ${MAX_STEPS} steps without submitting a decision.`;
    await prisma.agentRun.update({
      where: { id: runId },
      data: { status: RunStatus.FAILED, error },
    });
    return {
      runId,
      stepIndex,
      status: RunStatus.FAILED,
      finished: true,
      toolsCalled: [],
      assistantText: null,
      error,
    };
  }

  let response: ChatResponse;
  try {
    if (mode === "replay") {
      response = replayResponse(run.scenarioKey, stepIndex);
    } else {
      response = await chatCompletion({
        messages,
        tools: toolsForRequest(),
        model: options.model ?? env.OPENROUTER_MODEL,
      });
      if (options.record) {
        recordResponse(run.scenarioKey, stepIndex, response);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.agentRun.update({
      where: { id: runId },
      data: { status: RunStatus.FAILED, error: message },
    });
    return {
      runId,
      stepIndex,
      status: RunStatus.FAILED,
      finished: true,
      toolsCalled: [],
      assistantText: null,
      error: message,
    };
  }

  const assistant = response.message;
  const toolCalls = assistant.tool_calls ?? [];
  const assistantText =
    typeof assistant.content === "string" && assistant.content.trim() !== ""
      ? assistant.content
      : null;

  const nextMessages: ChatMessage[] = [
    ...messages,
    {
      role: "assistant",
      content: assistant.content ?? null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
  ];

  await prisma.agentStep.create({
    data: {
      runId,
      index: base,
      type: "assistant",
      name: null,
      payload: {
        text: assistantText,
        requestedTools: toolCalls.map((t) => t.function.name),
        finishReason: response.finishReason,
        model: response.model,
        usage: response.usage,
        mode,
      } as object,
    },
  });

  // The model answered in prose without calling anything. Nudge once rather
  // than failing: this is usually a weak model forgetting the tool contract.
  if (toolCalls.length === 0) {
    nextMessages.push({
      role: "user",
      content:
        "You must use the tools. Either call the data tools you still need, or call submit_decision with your final decision. Do not reply in prose.",
    });

    await prisma.agentRun.update({
      where: { id: runId },
      data: {
        status: RunStatus.RUNNING,
        stepCount: stepIndex + 1,
        messages: nextMessages as unknown as object,
        model: response.model,
      },
    });

    return {
      runId,
      stepIndex,
      status: RunStatus.RUNNING,
      finished: false,
      toolsCalled: [],
      assistantText,
      error: null,
    };
  }

  // Execute every requested tool in parallel.
  const executions = await Promise.all(
    toolCalls.map(async (call) => {
      const parsed = parseArguments(call.function.arguments);

      if (!parsed.ok) {
        return {
          call,
          name: call.function.name,
          args: {},
          result: { error: parsed.error },
          ok: false,
        };
      }

      const { ok, result } = await executeTool(call.function.name, parsed.args);
      return { call, name: call.function.name, args: parsed.args, result, ok };
    })
  );

  let decisionSubmitted = false;

  for (const [i, exec] of executions.entries()) {
    nextMessages.push({
      role: "tool",
      tool_call_id: exec.call.id,
      name: exec.name,
      content: JSON.stringify(exec.result),
    });

    await prisma.agentStep.create({
      data: {
        runId,
        index: base + i + 1,
        type: "tool",
        name: exec.name,
        payload: { args: exec.args, result: exec.result, ok: exec.ok } as object,
      },
    });

    if (exec.name === "submit_decision" && exec.ok) {
      const a = exec.args;

      const decision = DECISIONS.has(a.decision) ? a.decision : null;
      const constraint = CONSTRAINTS.has(a.binding_constraint)
        ? a.binding_constraint
        : "NONE";

      if (decision === null) {
        // Reject the submission and let the model correct itself.
        nextMessages.push({
          role: "user",
          content: `"${a.decision}" is not a valid decision. Call submit_decision again using one of: ${[...DECISIONS].join(", ")}.`,
        });
        continue;
      }

      const rawQty = Number(a.quantity);
      const quantity = Number.isFinite(rawQty) ? Math.trunc(rawQty) : 0;

      const factors = Array.isArray(a.factors)
        ? a.factors.map((f: unknown) => String(f))
        : [];

      // Supplier must be real. A hallucinated id would fail V8 later, but
      // catching it here keeps the decision record clean.
      const supplierId =
        typeof a.supplier_id === "string" && a.supplier_id.trim() !== ""
          ? a.supplier_id.trim()
          : null;

      const supplierExists = supplierId
        ? (await prisma.supplier.count({ where: { id: supplierId } })) > 0
        : false;

      const decisionData = {
        decision: decision as DecisionType,
        quantity,
        supplierId: supplierExists ? supplierId : null,
        bindingConstraint: constraint as BindingConstraint,
        urgent: Boolean(a.urgent),
        rationale: String(a.rationale ?? ""),
        factors: factors as unknown as object,
      };

      await prisma.agentDecision.upsert({
        where: { runId },
        create: { runId, ...decisionData },
        update: decisionData,
      });

      decisionSubmitted = true;
    }
  }

  const nextStatus = decisionSubmitted
    ? RunStatus.AWAITING_APPROVAL
    : RunStatus.RUNNING;

  await prisma.agentRun.update({
    where: { id: runId },
    data: {
      status: nextStatus,
      stepCount: stepIndex + 1,
      messages: nextMessages as unknown as object,
      model: response.model,
    },
  });

  return {
    runId,
    stepIndex,
    status: nextStatus,
    finished: decisionSubmitted,
    toolsCalled: executions.map((e) => e.name),
    assistantText,
    error: null,
  };
}

export interface CreateRunInput {
  scenarioKey: string;
  recommendationId?: string | null;
  triggerPoId?: string | null;
  userMessage: string;
  mode?: string;
}

export async function createRun(input: CreateRunInput) {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: input.userMessage },
  ];

  return prisma.agentRun.create({
    data: {
      scenarioKey: input.scenarioKey,
      recommendationId: input.recommendationId ?? null,
      triggerPoId: input.triggerPoId ?? null,
      status: RunStatus.PENDING,
      mode: input.mode ?? env.AGENT_MODE,
      messages: messages as unknown as object,
    },
  });
}

/** Drives a run to completion. Used by the CLI and tests, not by API routes. */
export async function runToCompletion(
  runId: string,
  options: StepOptions & { onStep?: (o: StepOutcome) => void } = {}
): Promise<StepOutcome> {
  let last: StepOutcome | null = null;

  for (let i = 0; i < MAX_STEPS; i++) {
    last = await stepRun(runId, options);
    options.onStep?.(last);
    if (last.finished) break;
  }

  if (!last) throw new Error("Run produced no steps.");
  return last;
}

export { TOOLS };