# Evaluation

Ground truth is `docs/decision-spec.md`, implemented in `src/domain/rules.ts`.

The agent is graded with **equivalence classes** (`src/domain/grading.ts`):

- Action and quantity are primary.
- Binding constraint is advisory.
- `urgent` is not graded.
- `REJECT` and `NO_ACTION` may be equivalent when nothing is purchased.
- `REJECT` and `MODIFY` are never equivalent.

## Suites

```bash
npm test          # pure unit tests (rules, validator, grading)
npm run test:db   # live Postgres: execution, rollback, replay
npm run agent S1-A -- --replay
```

Replay stubs **only** the model. Tools, Prisma, execution and validation are real.

A passing replay run must:

1. Obtain inventory, forecast, supplier terms and node constraints.
2. Recover from tool errors rather than deciding on empty lookups.
3. Match the primary grade for action, quantity and (for S2-A) supplier.
4. Return `INVESTIGATE` for S1-D.
5. Execute and validate a correct S1-A order.
6. Fail V5 and roll back after concurrent spend.
7. Feed the failure brief into a reinvestigation without prescribing a new quantity.
