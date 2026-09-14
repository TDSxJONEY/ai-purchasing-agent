# Purchasing agent

AI purchasing desk for a quick-commerce retailer. The replenishment system proposes quantities that are often wrong. An LLM investigates with **read-only** tools; a human approves; deterministic code writes the purchase order; an independent validator re-reads **live** Postgres state.

## Scenarios

| Key | Situation | Correct outcome |
|---|---|---|
| S1-A | 800 Wireless Earbuds Pro @ Delhi NCR | **MODIFY 250** (storage + lot size; open PO of 100) |
| S1-B | 800 Cola @ Mumbai West | **REJECT** — demand already covered |
| S1-C | 500 Olive Oil @ Bengaluru South | **REJECT / escalate** — MOQ unreachable |
| S1-D | 300 Whey Protein @ Hyderabad Central | **INVESTIGATE** — stale, divergent forecast |
| S1-E | 400 Toothpaste @ Pune East | **ACCEPT 400** |
| S2-A | Supplier confirms 250 of 500 AA batteries | **CREATE_SUPPLEMENTARY_PO 250 from Kavery** |

## Local setup

```bash
cp .env.example .env
# Fill DATABASE_URL and DIRECT_URL (Neon). Optionally OPENROUTER_API_KEY.
npm install
npx prisma generate
npx prisma db push
npm run db:seed
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Investigate S1-A (replay fixtures are in `fixtures/` so OpenRouter is optional).

```bash
npm test
npm run test:db
npm run agent S1-A -- --replay
```

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Pooled Neon URL. For serverless add `pgbouncer=true&connect_timeout=15`. |
| `DIRECT_URL` | Direct (unpooled) URL for Prisma `db push` / migrations |
| `OPENROUTER_API_KEY` | Required only for `AGENT_MODE=live` |
| `OPENROUTER_MODEL` | Default `anthropic/claude-sonnet-4.5` |
| `AGENT_MODE` | `live` or `replay` |
| `ADMIN_SEED_TOKEN` | Protects `/api/admin/seed` and `/api/admin/simulate-spend` in production |

`.env` is gitignored. Do not commit secrets.

## Deploy to Vercel

1. Create a Neon Postgres database.
2. Import the GitHub repo into Vercel. Framework: Next.js. Runtime is Node (Prisma is not Edge).
3. Set the environment variables above. `postinstall` already runs `prisma generate`.
4. Deploy. Vercel does **not** run `prisma db seed`. After the first deploy, `POST /api/admin/seed` with `Authorization: Bearer $ADMIN_SEED_TOKEN` (or click **Reset demo data** locally). Also run `npx prisma db push` against `DIRECT_URL` once so the schema exists.

Architecture: `docs/architecture.md`. Decision spec: `docs/decision-spec.md`. Evaluation: `docs/evaluation.md`.
