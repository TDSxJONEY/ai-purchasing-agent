"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { adminHeaders, clearAdminToken } from "@/lib/admin-client";
import { LedgerButton, Panel, Stamp } from "./ui";

interface QueueItem {
  scenarioKey: string;
  kind: "purchase" | "shortfall";
  title: string;
  sku: string;
  nodeName: string;
  recommendedQty: number | null;
  recommendationStatus: string;
  latestRun: { scenarioKey: string; status: string; id: string; createdAt: string } | null;
  catalog: {
    expected: { decision: string; quantity: number; note: string };
    recommendedQty: number | null;
  } | null;
}

export default function Dashboard() {
  const router = useRouter();
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ items: QueueItem[] }>("/api/recommendations");
      setItems(data.items ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the queue.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function investigate(scenarioKey: string) {
    setBusy(scenarioKey);
    try {
      const data = await api<{ runId: string }>("/api/runs", {
        method: "POST",
        body: JSON.stringify({ scenarioKey }),
      });
      router.push(`/runs/${data.runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start investigation.");
      setBusy(null);
    }
  }

  async function resetDemo() {
    if (!confirm("Wipe operational data and restore the six demo scenarios?")) return;
    setBusy("reset");
    try {
      await api("/api/admin/seed", {
        method: "POST",
        headers: adminHeaders(),
      });
      await load();
    } catch (err) {
      clearAdminToken();
      setError(err instanceof Error ? err.message : "Reset failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-6 border-b border-rule pb-6">
        <div>
          <p className="font-mono text-[11px] tracking-[0.22em] text-muted uppercase">
            Quick-commerce purchasing
          </p>
          <h1 className="mt-2 text-4xl tracking-tight">The desk</h1>
          <p className="mt-3 max-w-xl text-muted">
            Recommendations arrive already filled in. The agent investigates; a human
            still signs the order. Nothing writes a purchase order except deterministic code.
          </p>
        </div>
        <LedgerButton variant="ghost" onClick={resetDemo} disabled={busy === "reset"}>
          {busy === "reset" ? "Resetting…" : "Reset demo data"}
        </LedgerButton>
      </header>

      {error ? <p className="mt-6 text-bad">{error}</p> : null}

      <div className="mt-8 space-y-4">
        {(items ?? []).map((item) => {
          const expected = item.catalog?.expected;
          return (
            <article key={item.scenarioKey} className="border border-rule bg-panel p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Stamp>{item.scenarioKey}</Stamp>
                    <Stamp tone={item.kind === "shortfall" ? "accent" : "ink"}>
                      {item.kind === "shortfall" ? "Supplier shortfall" : "Recommendation"}
                    </Stamp>
                    {item.latestRun ? <Stamp>{item.latestRun.status}</Stamp> : null}
                  </div>
                  <h2 className="mt-3 text-2xl">{item.title}</h2>
                  <p className="mt-1 font-mono text-sm text-muted">
                    {item.sku} · {item.nodeName}
                  </p>
                </div>
                <div className="text-right">
                  {item.kind === "purchase" && item.recommendedQty != null ? (
                    <p className="font-mono text-3xl">{item.recommendedQty}</p>
                  ) : (
                    <p className="font-mono text-sm text-accent">500 ordered · 250 confirmed</p>
                  )}
                  <p className="mt-1 text-xs tracking-[0.14em] text-muted uppercase">
                    {item.kind === "purchase" ? "System recommendation" : "Original PO"}
                  </p>
                </div>
              </div>

              {expected ? (
                <p className="mt-4 max-w-3xl text-sm text-muted">{expected.note}</p>
              ) : null}

              <div className="mt-5 flex flex-wrap items-center gap-3">
                <LedgerButton
                  onClick={() => void investigate(item.scenarioKey)}
                  disabled={busy === item.scenarioKey}
                >
                  {busy === item.scenarioKey ? "Opening…" : "Investigate"}
                </LedgerButton>
                {item.latestRun ? (
                  <button
                    className="text-sm border-b border-rule pb-0.5"
                    onClick={() => router.push(`/runs/${item.latestRun!.id}`)}
                  >
                    Open last run
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      {items === null && !error ? (
        <p className="mt-8 font-mono text-sm text-muted">Loading the queue…</p>
      ) : null}

      {items && items.length === 0 && !error ? (
        <Panel kicker="Empty" title="No operational data">
          <p className="text-muted">
            Seed the database locally with <code className="font-mono">npm run db:seed</code>, or
            use Reset demo data after deploying.
          </p>
        </Panel>
      ) : null}
    </main>
  );
}
