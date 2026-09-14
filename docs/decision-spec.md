# Purchasing Decision Specification

This document is the **source of truth** for correct purchasing behaviour.

Three independent things are derived from it:

1. `src/domain/rules.ts` — the deterministic reference implementation
2. `src/domain/validate.ts` — the post-execution validator
3. The agent's system prompt — expressed as business context, **not** as this formula

The agent is never given this formula and never calls `rules.ts`. It receives raw
operational data through tools and must reason its way to a decision. That is what
makes validation meaningful: if the agent were handed the calculator, the validator
would have nothing independent to check.

---

## 1. Definitions

| Term | Meaning |
|---|---|
| `available` | `inventory.onHand - inventory.reserved` |
| `incoming` | Σ quantity of OPEN/PARTIAL purchase orders for this product+node arriving within `horizonDays` |
| `demand` | `forecast.forecastUnits + forecast.safetyStock` over `horizonDays` |
| `netRequirement` | Units genuinely needed. See §3. |
| `moq` | Supplier minimum order quantity |
| `lotSize` | Supplier order increment (orders must be a multiple) |
| `headroomStorage` | `storageCapacity - storageUsed - incoming` |
| `headroomBudget` | `floor((budgetTotal - budgetUsed) / unitPrice)` in units |

`incoming` is subtracted from storage headroom because already-ordered stock will
occupy the same shelf space when it lands.

---

## 2. Evidence gate (evaluated first)

If either condition holds, the decision is **INVESTIGATE** and no quantity is
proposed. The arithmetic in §3 is not performed.

- `forecast.updatedAt` is more than **14 days** old, **or**
- `actualLast7d` diverges from the forecast run-rate by more than **30%**

```
  forecastRunRate7d = forecastUnits * (7 / horizonDays)
  divergence = |actualLast7d - forecastRunRate7d| / forecastRunRate7d
```

Rationale: acting on stale or contradicted demand data is worse than pausing. The
agent must be able to say "I don't have good enough evidence" rather than always
producing a number.

---

## 3. Quantity derivation

```
netRequirement = max(0, demand - available - incoming)

if netRequirement == 0:
    return REJECT(reason = "demand already covered")

qty = roundUpToLot(netRequirement, lotSize)
if qty < moq:
    qty = moq                          # round UP to reach the supplier minimum

cap = min(headroomStorage, headroomBudget)
qty = roundDownToLot(min(qty, cap), lotSize)   # round DOWN when capping

if qty < moq:
    return REJECT(reason = "cannot satisfy MOQ within storage/budget constraints",
                  escalate = true)
```

**The rounding asymmetry is deliberate.** Round *up* when meeting demand (a partial
lot is not orderable). Round *down* when capping (exceeding a hard constraint is not
permitted). Implementations must respect both directions.

---

## 4. Decision mapping

| Condition | Decision |
|---|---|
| Evidence gate fails | `INVESTIGATE` |
| `netRequirement == 0` | `REJECT` |
| Final `qty < moq` | `REJECT` (escalate) |
| `qty == recommendedQty` | `ACCEPT` |
| otherwise | `MODIFY` to `qty` |

Every decision must name its **binding constraint** — the term that actually
determined the outcome (`demand`, `storage`, `budget`, `moq`, or `evidence`).

---

## 5. Urgency check

```
dailyDemand    = demand / horizonDays
daysToStockout = available / dailyDemand
```

If `supplier.leadTimeDays > daysToStockout`, flag `urgent` and evaluate alternate
suppliers with shorter lead times, even at higher unit cost. Urgency does not change
the quantity — only supplier selection and escalation.

---

## 6. Partial fulfilment (Scenario 2)

When a supplier confirms less than the ordered quantity:

```
shortfall = po.quantity - po.confirmedQty

remainingNeed = max(0, demand - available - (incoming including confirmedQty))
if remainingNeed == 0:
    return NO_ACTION(reason = "existing position covers demand despite shortfall")

for each alternate supplier, ascending by leadTimeDays:
    q = roundUpToLot(remainingNeed, alt.lotSize)
    if q < alt.moq: q = alt.moq
    q = roundDownToLot(min(q, headroomStorage, headroomBudget(alt.unitPrice)), alt.lotSize)
    if q >= alt.moq and alt.leadTimeDays <= daysToStockout:
        return CREATE_SUPPLEMENTARY_PO(alt, q)

return ESCALATE(reason = "no alternate supplier can close the shortfall in time")
```

---

## 7. Validation (independent, post-execution)

The validator re-reads **live database state at execution time** and re-checks the
created purchase order. It does not trust the agent's snapshot.

Checks:

| # | Check |
|---|---|
| V1 | `quantity > 0` |
| V2 | `quantity >= supplier.moq` |
| V3 | `quantity % supplier.lotSize == 0` |
| V4 | `quantity <= headroomStorage` *(recomputed now)* |
| V5 | `quantity * unitPrice <= budgetTotal - budgetUsed` *(recomputed now)* |
| V6 | Resulting position does not exceed `demand` by more than 20% |
| V7 | `po.quantity` matches the agent's stated `decision.quantity` |
| V8 | Supplier actually supplies this product |

Any failed check → PO is rolled back to `DRAFT`, the run is marked
`VALIDATION_FAILED`, and a re-investigation run is spawned carrying the failed checks
as new evidence.

**V4 and V5 can fail even when the agent reasoned correctly** — budget or storage may
have been consumed between investigation and approval. This is the intended source of
divergence, and the reason the feedback loop is not dead code.

---

## 8. Ground-truth scenarios

All figures verified by hand against §2–§4.

### S1-A — MODIFY (flagship)
Wireless Earbuds @ Delhi-NCR. Recommended **800**.

| Input | Value |
|---|---|
| onHand / reserved | 120 / 20 → available **100** |
| forecast (14d) / safety | 500 / 50 → demand **550** |
| open PO | 100, arrives day 5 → incoming **100** |
| moq / lotSize / price | 100 / 50 / ₹450 |
| budget remaining | ₹200,000 |
| storage cap / used | 500 / 120 |

```
netRequirement = 550 - 100 - 100          = 350
headroomStorage = 500 - 120 - 100         = 280
headroomBudget  = floor(200000 / 450)     = 444
qty = roundDownToLot(min(350, 280, 444))  = roundDownToLot(280) = 250
```
→ **MODIFY to 250**, binding constraint `storage`.
The open PO of 100 is the detail a hurried buyer misses.

### S1-B — REJECT (already covered)
available 400, demand 330, incoming 0 → `netRequirement = 0`.
Recommended 800 → **REJECT**, binding constraint `demand`.

### S1-C — REJECT (MOQ unreachable)
netRequirement 60, moq 500, lotSize 10, headroomStorage 100.
`qty` raised to 500, capped to 100, `100 < 500` → **REJECT + escalate**,
binding constraint `moq`.

### S1-D — INVESTIGATE (stale evidence)
`forecast.updatedAt` 21 days old; `actualLast7d` 60% above run-rate.
Evidence gate fails → **INVESTIGATE**, binding constraint `evidence`.

### S1-E — ACCEPT
available 100, demand 500 (450 + 50), incoming 0, lotSize 50, moq 100,
price ₹200, budget remaining ₹100,000, storage cap 800 / used 100.

```
netRequirement = 500 - 100 - 0            = 400
headroomStorage = 800 - 100 - 0           = 700
headroomBudget  = floor(100000 / 200)     = 500
qty = roundDownToLot(min(400, 700, 500))  = 400
```
Recommended **400** → **ACCEPT**, binding constraint `demand`.

### S2-A — Partial fulfilment
PO for 500 from Supplier A confirmed at **250**. Shortfall 250.
Supplier B: moq 200, lotSize 50, lead 9d, ₹520. `daysToStockout` ≈ 11.
`250 >= 200`, `250 % 50 == 0`, `9 <= 11`, budget covers ₹130,000
→ **supplementary PO to Supplier B for 250**.