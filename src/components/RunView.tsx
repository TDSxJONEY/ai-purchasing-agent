"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { adminHeaders, clearAdminToken } from "@/lib/admin-client";
import { LedgerButton, Panel, Stamp } from "./ui";

interface StepPayload {
  text?: string | null;
  requestedTools?: string[];
  args?: Record<string, unknown>;
  result?: unknown;
  ok?: boolean;
}

interface RunPayload {
  run: {
    id: string;
    scenarioKey: string;
    status: string;
    stepCount: number;
    error: string | null;
    steps: Array<{
      id: string;
      index: number;
      type: string;
      name: string | null;
      payload: StepPayload;
    }>;
    decision: {
      decision: string;
      quantity: number | null;
      bindingConstraint: string;
      urgent: boolean;
      rationale: string;
      factors: string[];
      supplier: { name: string } | null;
    } | null;
    validations: Array<{
      passed: boolean;
      checks: {
        passed: boolean;
        summary: string;
        failedIds: string[];
        checks: Array<{ id: string; label: string; passed: boolean; detail: string }>;
      };
    }>;
    resultPo: {
      id: string;
      quantity: number;
      status: string;
      unitPrice: number;
      supplier: { name: string };
    } | null;
    recommendation: { recommendedQty: number } | null;
    triggerPo: {
      id: string;
      quantity: number;
      confirmedQty: number | null;
      supplier: { name: string };
    } | null;
  };
  situation: {
    productId: string;
    nodeId: string;
    productName?: string;
    productSku?: string;
    nodeCode?: string;
    nodeName?: string;
    recommendedQty?: number;
    available?: number;
    incoming?: number;
    onHand?: number;
    reserved?: number;
  } | null;
  catalog: {
    recommendedQty: number | null;
    expected: { decision: string; quantity: number };
  } | null;
  brief: string | null;
}

function statusTone(status: string): "good" | "bad" | "accent" | "ink" {
  if (status === "VALIDATED") return "good";
  if (status === "VALIDATION_FAILED" || status === "FAILED") return "bad";
  if (status === "AWAITING_APPROVAL") return "accent";
  return "ink";
}

export default function RunView({ runId }: { runId: string }) {
  const [data, setData] = useState<RunPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const stepping = useRef(false);

  const refresh = useCallback(async () => {
    const payload = await api<RunPayload>(`/api/runs/${runId}`);
    setData(payload);
    return payload;
  }, [runId]);

  useEffect(() => {
    let cancelled = false;

    async function loop() {
      if (stepping.current) return;
      stepping.current = true;
      try {
        let payload = await refresh();
        while (
          !cancelled &&
          (payload.run.status === "PENDING" || payload.run.status === "RUNNING")
        ) {
          await api(`/api/runs/${runId}/step`, { method: "POST" });
          payload = await refresh();
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Investigation failed.");
        }
      } finally {
        stepping.current = false;
      }
    }

    void loop();
    return () => {
      cancelled = true;
    };
  }, [refresh, runId]);

  async function approve() {
    setBusy("approve");
    try {
      await api(`/api/runs/${runId}/approve`, { method: "POST" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approval failed.");
    } finally {
      setBusy(null);
    }
  }

  async function drift() {
    if (!data?.situation?.nodeId) {
      setError("No nodeId on this run — cannot consume budget.");
      return;
    }
    setBusy("drift");
    try {
      await api("/api/admin/simulate-spend", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ nodeId: data.situation.nodeId, amount: 150000 }),
      });
      await refresh();
    } catch (err) {
      clearAdminToken();
      setError(err instanceof Error ? err.message : "Could not simulate spend.");
    } finally {
      setBusy(null);
    }
  }

  async function reinvestigate() {
    setBusy("reinvestigate");
    try {
      const next = await api<{ runId: string }>(`/api/runs/${runId}/reinvestigate`, {
        method: "POST",
      });
      window.location.href = `/runs/${next.runId}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start reinvestigation.");
      setBusy(null);
    }
  }

  if (!data) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-16">
        <p className="font-mono text-sm text-muted">{error ?? "Opening the file…"}</p>
      </main>
    );
  }

  const { run, situation, catalog, brief } = data;
  const recommended = catalog?.recommendedQty ?? run.recommendation?.recommendedQty ?? null;
  const decidedQty = run.decision?.quantity ?? null;
  const modified =
    run.decision?.decision === "MODIFY" &&
    recommended != null &&
    decidedQty != null &&
    recommended !== decidedQty;
  const validation = run.validations[0] ?? null;
  const investigating = run.status === "PENDING" || run.status === "RUNNING";

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link href="/" className="font-mono text-xs tracking-[0.18em] uppercase text-muted">
        ← Queue
      </Link>

      <header className="mt-4 flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-6">
        <div>
          <div className="flex flex-wrap gap-2">
            <Stamp>{run.scenarioKey}</Stamp>
            <Stamp tone={statusTone(run.status)}>{run.status}</Stamp>
          </div>
          <h1 className="mt-3 text-4xl tracking-tight">Investigation</h1>
        </div>
        {modified ? (
          <div className="text-right">
            <p className="font-mono text-4xl">
              <span className="text-muted line-through decoration-2">{recommended}</span>
              <span className="ml-3 text-accent">{decidedQty}</span>
            </p>
            <p className="mt-1 text-xs tracking-[0.14em] text-muted uppercase">
              Recommendation struck · corrected quantity
            </p>
          </div>
        ) : null}
      </header>

      {error ? <p className="mt-6 text-bad">{error}</p> : null}

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <Panel kicker="What the buyer can see" title="Situation">
          {situation ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-sm">
              <dt className="text-muted">Product ID</dt>
              <dd>{situation.productId}</dd>
              <dt className="text-muted">Node ID</dt>
              <dd>{situation.nodeId}</dd>
              {situation.nodeName ? (
                <>
                  <dt className="text-muted">Node</dt>
                  <dd>{situation.nodeName}</dd>
                </>
              ) : null}
              {recommended != null ? (
                <>
                  <dt className="text-muted">Recommended</dt>
                  <dd>{recommended}</dd>
                </>
              ) : null}
              {run.triggerPo ? (
                <>
                  <dt className="text-muted">Shortfall PO</dt>
                  <dd>
                    {run.triggerPo.confirmedQty ?? 0} of {run.triggerPo.quantity} from{" "}
                    {run.triggerPo.supplier.name}
                  </dd>
                </>
              ) : null}
            </dl>
          ) : (
            <p className="text-muted">No situation snapshot on this run.</p>
          )}
        </Panel>

        <Panel kicker="Trace" title="Investigation">
          {investigating ? (
            <p className="font-mono text-sm text-accent">Stepping the agent — one model call per request.</p>
          ) : null}
          <ol className="space-y-3 font-mono text-sm">
            {run.steps.map((step) => (
              <li key={step.id} className="border-l border-rule pl-3">
                <p className="text-xs tracking-[0.14em] text-muted uppercase">
                  {step.type}
                  {step.name ? ` · ${step.name}` : ""}
                </p>
                {step.type === "assistant" && step.payload.text ? (
                  <p className="mt-1 text-muted">{step.payload.text}</p>
                ) : null}
                {step.payload.requestedTools?.length ? (
                  <p className="mt-1">called {step.payload.requestedTools.join(", ")}</p>
                ) : null}
                {step.type === "tool" ? (
                  <p className="mt-1 text-muted">
                    {step.payload.ok === false ? "error" : "ok"}{" "}
                    {JSON.stringify(step.payload.result).slice(0, 180)}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </Panel>
      </div>

      {run.decision ? (
        <div className="mt-4">
          <Panel kicker="Agent" title={`${run.decision.decision}`}>
            <div className="flex flex-wrap items-baseline gap-6">
              {modified ? (
                <p className="font-mono text-4xl">
                  <span className="text-muted line-through">{recommended}</span>
                  <span className="ml-3 text-accent">{decidedQty}</span>
                </p>
              ) : (
                <p className="font-mono text-4xl">{decidedQty ?? 0}</p>
              )}
              <div className="font-mono text-sm text-muted">
                <p>Constraint {run.decision.bindingConstraint}</p>
                <p>Supplier {run.decision.supplier?.name ?? "none"}</p>
                <p>Urgent {run.decision.urgent ? "yes" : "no"} (not graded)</p>
              </div>
            </div>
            <p className="mt-4 max-w-3xl">{run.decision.rationale}</p>
            <ul className="mt-3 list-disc pl-5 text-sm text-muted">
              {(Array.isArray(run.decision.factors) ? run.decision.factors : []).map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </Panel>
        </div>
      ) : null}

      {run.status === "AWAITING_APPROVAL" && run.decision ? (
        <div className="mt-4 border border-accent bg-panel p-5">
          <h2 className="text-xl">Human approval</h2>
          <p className="mt-2 max-w-2xl text-muted">
            The agent cannot write a purchase order. Approving runs deterministic execution, then
            an independent validator against live database state.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <LedgerButton onClick={() => void approve()} disabled={busy !== null}>
              {busy === "approve" ? "Executing…" : "Approve buying decision"}
            </LedgerButton>
            <LedgerButton variant="ghost" onClick={() => void drift()} disabled={busy !== null}>
              {busy === "drift" ? "Consuming budget…" : "Simulate concurrent spend"}
            </LedgerButton>
          </div>
          <p className="mt-3 font-mono text-xs text-muted">
            Drift consumes ₹150,000 at node {situation?.nodeId ?? "(unknown)"} so a later
            approval can fail V5.
          </p>
        </div>
      ) : null}

      {validation ? (
        <div className="mt-4">
          <Panel
            kicker="Independent validator"
            title={validation.passed ? "Validation passed" : "Validation failed"}
          >
            <p className="text-sm text-muted">{validation.checks.summary}</p>
            <ul className="mt-3 space-y-2 font-mono text-sm">
              {(validation.checks.checks ?? []).map((check) => (
                <li key={check.id} className={check.passed ? "text-good" : "text-bad"}>
                  {check.id} {check.passed ? "PASS" : "FAIL"} — {check.label}. {check.detail}
                </li>
              ))}
            </ul>
            {run.resultPo ? (
              <p className="mt-4 text-sm">
                PO {run.resultPo.id} is {run.resultPo.status} for {run.resultPo.quantity} units
                from {run.resultPo.supplier.name}.
              </p>
            ) : null}
          </Panel>
        </div>
      ) : null}

      {run.status === "VALIDATION_FAILED" ? (
        <div className="mt-4 border border-bad bg-panel p-5">
          <h2 className="text-xl">Feedback loop</h2>
          <p className="mt-2 max-w-2xl text-muted">
            The purchase order was rolled back to DRAFT and budget restored. A second
            investigation receives the failed checks as evidence and must re-read live state.
          </p>
          {brief ? (
            <pre className="mt-4 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-muted">
              {brief}
            </pre>
          ) : null}
          <div className="mt-4">
            <LedgerButton onClick={() => void reinvestigate()} disabled={busy !== null}>
              {busy === "reinvestigate" ? "Opening…" : "Investigate again"}
            </LedgerButton>
          </div>
        </div>
      ) : null}

      {run.error ? <p className="mt-6 text-bad">{run.error}</p> : null}
    </main>
  );
}
