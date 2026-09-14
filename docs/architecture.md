# Architecture

The purchasing desk separates **judgement** from **effect**.

```
recommendation / supplier shortfall
        ↓
LLM agent (read-only tools + submit_decision)
        ↓
human approval
        ↓
deterministic executePurchase()
        ↓
independent validator against LIVE database state
        ↓
OPEN PO  or  DRAFT + budget restore + VALIDATION_FAILED + reinvestigation
```

## Runtime

- Next.js App Router, **Node** runtime (not Edge). Prisma cannot run on Edge.
- One LLM call per `POST /api/runs/:runId/step`. The client loops until the run finishes. This is required for Vercel duration limits.
- PostgreSQL via Neon. `DATABASE_URL` is the pooled connection; `DIRECT_URL` is used by Prisma for schema push.
- LLM via OpenRouter. `AGENT_MODE=replay` stubs only the model; tools still hit the database.

## Modules

| Path | Role |
|---|---|
| `src/lib/scenarios.ts` | Static catalog (IDs, titles, expected outcomes) |
| `src/domain/scenarios.ts` | Runtime setup and ground-truth computation |
| `src/domain/rules.ts` | Deterministic reference. **Not** a tool. |
| `src/domain/grading.ts` | Equivalence-class grading (`src/domain/grade.ts` re-exports) |
| `src/domain/validate.ts` | Independent V1–V8 checks. Does not call `decidePurchase()`. |
| `src/domain/execute.ts` | Transactional PO create, budget debit, rollback, idempotency `run-${runId}` |
| `src/agent/tools.ts` | Six read tools + `submit_decision`. IDs resolve by id **or** SKU/code. |
| `src/lib/seed.ts` | Reusable seed. `prisma/seed.ts` is the CLI wrapper. |

## Safety

The model has no write tools. Approval creates the PO. Validation re-reads state after the write. If budget or storage moved in between, V4/V5/V6 can fail even when the agent was right.
